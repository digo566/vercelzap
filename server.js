const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

let client = null;
let wsConnection = null;

// Armazena automação global (única para todos os contatos)
let globalAutomation = null;
// Armazena timers de inatividade por contato
const inactivityTimers = new Map();

function createWhatsAppClient(ws) {
    if (client) {
        try {
            client.destroy().catch(() => {});
        } catch (e) {
            console.log('Cliente anterior já destruído');
        }
        client = null;
    }

    setTimeout(() => {
        try {
            client = new Client({
                authStrategy: new LocalAuth({
                    dataPath: './.wwebjs_auth'
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-features=IsolateOrigins,site-per-process',
                        '--disable-blink-features=AutomationControlled',
                        '--window-size=1920,1080',
                        '--disable-extensions',
                        '--disable-default-apps'
                    ],
                    ignoreHTTPSErrors: true,
                    timeout: 120000,
                    handleSIGINT: false,
                    handleSIGTERM: false,
                    handleSIGHUP: false
                },
            });

            setupClientEvents(ws);
            
            client.initialize().catch(error => {
                console.error('Erro ao inicializar cliente:', error);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Erro ao inicializar WhatsApp. Tente limpar o cache e reiniciar.'
                    }));
                }
            });
        } catch (error) {
            console.error('Erro ao criar cliente:', error);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Erro ao criar cliente WhatsApp: ' + error.message
                }));
            }
        }
    }, 1000);
}

function setupClientEvents(ws) {
    if (!client) return;

    client.on('qr', async (qr) => {
        console.log('QR Code gerado');
        try {
            const qrImage = await qrcode.toDataURL(qr);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'qr',
                    qr: qrImage
                }));
            }
        } catch (err) {
            console.error('Erro ao gerar QR Code:', err);
        }
    });

    client.on('ready', async () => {
        console.log('WhatsApp conectado!');
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ready'
            }));
            
            try {
                const contacts = await client.getContacts();
                const validContacts = contacts.filter(contact => 
                    contact.isUser && 
                    contact.number && 
                    !contact.isGroup &&
                    contact.id.includes('@c.us')
                );
                
                const formattedContacts = validContacts.map(contact => {
                    let contactId = contact.id._serialized || contact.id || '';
                    if (typeof contactId === 'object') {
                        contactId = contactId._serialized || contactId.id || '';
                    }
                    const number = contact.number || contactId.replace('@c.us', '').replace('@s.whatsapp.net', '');
                    return {
                        id: contactId,
                        name: contact.pushname || contact.name || number || 'Sem nome',
                        number: number
                    };
                });
                
                console.log(`Encontrados ${formattedContacts.length} contatos`);
                
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'contacts',
                        contacts: formattedContacts
                    }));
                }
            } catch (error) {
                console.error('Erro ao buscar contatos:', error);
            }
        }
    });

    // Handler para mensagens recebidas - automação global
    client.on('message', async (message) => {
        // Ignorar mensagens de grupos e status
        if (message.from.includes('@g.us') || message.from.includes('status@broadcast')) {
            return;
        }

        console.log('Mensagem recebida de:', message.from, 'Conteúdo:', message.body);
        
        // Limpar timer de inatividade quando cliente responde
        if (inactivityTimers.has(message.from)) {
            clearTimeout(inactivityTimers.get(message.from));
            inactivityTimers.delete(message.from);
            console.log('Timer de inatividade cancelado para:', message.from);
        }

        // Notificar frontend sobre nova mensagem
        if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
            wsConnection.send(JSON.stringify({
                type: 'messageReceived',
                from: message.from,
                body: message.body,
                timestamp: message.timestamp
            }));
        }

        // Processar automação global se estiver ativa
        if (globalAutomation && globalAutomation.active) {
            console.log('Automação global ativa - processando mensagem de:', message.from);
            
            // Verificar respostas automáticas
            if (globalAutomation.autoReplies && globalAutomation.autoReplies.length > 0) {
                const messageText = message.body.toLowerCase().trim();
                
                // Procurar por resposta correspondente
                for (const reply of globalAutomation.autoReplies) {
                    const keywords = reply.keyword.toLowerCase().split(',').map(k => k.trim());
                    
                    // Verificar se alguma palavra-chave corresponde
                    if (keywords.some(keyword => messageText === keyword || messageText.includes(keyword))) {
                        console.log('Palavra-chave encontrada:', reply.keyword, '- Enviando resposta para:', message.from);
                        
                        try {
                            await client.sendMessage(message.from, reply.response);
                            console.log('Resposta automática enviada para:', message.from);
                            
                            // Notificar frontend
                            if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                                wsConnection.send(JSON.stringify({
                                    type: 'autoReplyTriggered',
                                    chatId: message.from,
                                    keyword: reply.keyword,
                                    response: reply.response
                                }));
                            }
                        } catch (error) {
                            console.error('Erro ao enviar resposta automática:', error);
                        }
                        
                        break; // Enviar apenas a primeira resposta correspondente
                    }
                }
            }
            
            // Se tem mensagem de inatividade configurada, iniciar timer
            if (globalAutomation.inactivityMessage && globalAutomation.inactivityTime > 0) {
                startInactivityTimer(message.from, globalAutomation);
            }
        }
    });

    client.on('authenticated', () => {
        console.log('Autenticado!');
    });

    client.on('auth_failure', (msg) => {
        console.error('Falha na autenticação:', msg);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Falha na autenticação: ' + msg
            }));
        }
    });

    client.on('disconnected', (reason) => {
        console.log('Desconectado:', reason);
        // Limpar automação e timers
        globalAutomation = null;
        inactivityTimers.forEach(timer => clearTimeout(timer));
        inactivityTimers.clear();
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Desconectado: ' + reason
            }));
        }
    });

    client.on('loading_screen', (percent, message) => {
        console.log('Carregando:', percent, message);
    });

    client.on('change_state', (state) => {
        console.log('Estado mudou:', state);
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
}

// Função para iniciar timer de inatividade
function startInactivityTimer(chatId, automation) {
    // Limpar timer anterior se existir
    if (inactivityTimers.has(chatId)) {
        clearTimeout(inactivityTimers.get(chatId));
    }

    console.log(`Iniciando timer de inatividade para ${chatId}: ${automation.inactivityTime} segundos`);

    const timer = setTimeout(async () => {
        console.log(`Timer de inatividade acionado para ${chatId}`);
        try {
            await client.sendMessage(chatId, automation.inactivityMessage);
            console.log('Mensagem de inatividade enviada para:', chatId);
            
            // Notificar frontend
            if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
                wsConnection.send(JSON.stringify({
                    type: 'inactivityMessageSent',
                    chatId: chatId,
                    message: automation.inactivityMessage
                }));
            }
        } catch (error) {
            console.error('Erro ao enviar mensagem de inatividade:', error);
        }
        inactivityTimers.delete(chatId);
    }, automation.inactivityTime * 1000);

    inactivityTimers.set(chatId, timer);
}

// WebSocket connection
wss.on('connection', (ws) => {
    console.log('Cliente WebSocket conectado');
    wsConnection = ws;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.action === 'connect') {
                if (!client) {
                    createWhatsAppClient(ws);
                } else {
                    try {
                        if (client.info) {
                            ws.send(JSON.stringify({ type: 'ready' }));
                            // Reenviar contatos
                            const contacts = await client.getContacts();
                            const validContacts = contacts.filter(contact => 
                                contact.isUser && 
                                contact.number && 
                                !contact.isGroup &&
                                contact.id.includes('@c.us')
                            );
                            
                            const formattedContacts = validContacts.map(contact => {
                                let contactId = contact.id._serialized || contact.id || '';
                                if (typeof contactId === 'object') {
                                    contactId = contactId._serialized || contactId.id || '';
                                }
                                const number = contact.number || contactId.replace('@c.us', '').replace('@s.whatsapp.net', '');
                                return {
                                    id: contactId,
                                    name: contact.pushname || contact.name || number || 'Sem nome',
                                    number: number
                                };
                            });
                            
                            ws.send(JSON.stringify({
                                type: 'contacts',
                                contacts: formattedContacts
                            }));

                            // Enviar automação global se existir
                            if (globalAutomation) {
                                ws.send(JSON.stringify({
                                    type: 'globalAutomation',
                                    automation: globalAutomation
                                }));
                            }
                        } else {
                            if (client) {
                                await client.destroy().catch(() => {});
                            }
                            client = null;
                            createWhatsAppClient(ws);
                        }
                    } catch (error) {
                        console.error('Erro ao verificar cliente:', error);
                        if (client) {
                            await client.destroy().catch(() => {});
                        }
                        client = null;
                        createWhatsAppClient(ws);
                    }
                }
            } else if (data.action === 'disconnect') {
                if (client) {
                    await client.destroy();
                    client = null;
                }
                globalAutomation = null;
                inactivityTimers.forEach(timer => clearTimeout(timer));
                inactivityTimers.clear();
            } else if (data.action === 'sendMessages') {
                await sendMessagesToClients(data.clients, data.message, ws);
            } else if (data.action === 'startGlobalAutomation') {
                startGlobalAutomation(data.automation, ws);
            } else if (data.action === 'stopGlobalAutomation') {
                stopGlobalAutomation(ws);
            } else if (data.action === 'getGlobalAutomation') {
                sendGlobalAutomation(ws);
            } else if (data.action === 'getContacts') {
                if (client && client.info) {
                    try {
                        const contacts = await client.getContacts();
                        const validContacts = contacts.filter(contact => 
                            contact.isUser && 
                            contact.number && 
                            !contact.isGroup &&
                            contact.id.includes('@c.us')
                        );
                        
                        const formattedContacts = validContacts.map(contact => {
                            let contactId = contact.id._serialized || contact.id || '';
                            if (typeof contactId === 'object') {
                                contactId = contactId._serialized || contactId.id || '';
                            }
                            const number = contact.number || contactId.replace('@c.us', '').replace('@s.whatsapp.net', '');
                            return {
                                id: contactId,
                                name: contact.pushname || contact.name || number || 'Sem nome',
                                number: number
                            };
                        });
                        
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'contacts',
                                contacts: formattedContacts
                            }));
                        }
                    } catch (error) {
                        console.error('Erro ao buscar contatos:', error);
                    }
                }
            }
        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: error.message
                }));
            }
        }
    });

    ws.on('close', () => {
        console.log('Cliente WebSocket desconectado');
        wsConnection = null;
    });
});

// Função para enviar mensagens em massa
async function sendMessagesToClients(clients, message, ws) {
    if (!client || !client.info) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'WhatsApp não está conectado'
        }));
        return;
    }

    const total = clients.length;
    let sent = 0;

    for (const clientNumber of clients) {
        try {
            const number = clientNumber.includes('@c.us') 
                ? clientNumber 
                : `${clientNumber}@c.us`;

            await client.sendMessage(number, message);
            sent++;

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'messageStatus',
                    status: sent < total ? 'sending' : 'completed',
                    sent: sent,
                    total: total
                }));
            }

            if (sent < total) {
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        } catch (error) {
            console.error(`Erro ao enviar para ${clientNumber}:`, error);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'messageStatus',
                    status: 'error',
                    message: `Erro ao enviar para ${clientNumber}: ${error.message}`
                }));
            }
        }
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'messageStatus',
            status: 'completed',
            sent: sent,
            total: total
        }));
    }
}

// Função para iniciar automação global
function startGlobalAutomation(automation, ws) {
    if (!client || !client.info) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'WhatsApp não está conectado'
        }));
        return;
    }

    try {
        // Salvar automação global
        globalAutomation = {
            ...automation,
            active: true,
            startedAt: new Date().toISOString()
        };

        console.log('Automação global iniciada:', globalAutomation);

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'globalAutomationStarted',
                automation: globalAutomation
            }));
        }
    } catch (error) {
        console.error('Erro ao iniciar automação global:', error);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Erro ao iniciar automação: ' + error.message
            }));
        }
    }
}

// Função para parar automação global
function stopGlobalAutomation(ws) {
    // Limpar todos os timers de inatividade
    inactivityTimers.forEach(timer => clearTimeout(timer));
    inactivityTimers.clear();

    // Remover automação global
    globalAutomation = null;

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'globalAutomationStopped'
        }));
    }

    console.log('Automação global parada');
}

// Função para enviar automação global
function sendGlobalAutomation(ws) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'globalAutomation',
            automation: globalAutomation
        }));
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log(`Abra o arquivo zap.html no navegador`);
});