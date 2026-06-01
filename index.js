const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const express = require('express')
const cors = require('cors')
const axios = require('axios')
const qrcode = require('qrcode')
const path = require('path')
const fs = require('fs')

const app = express()
app.use(cors())
app.use(express.json())

const sessions = {}
const qrCodes = {}

const BACKEND_URL = process.env.BACKEND_URL || 'https://ai-agent-backend-production-c1c0.up.railway.app'

async function createSession(businessId) {
    const sessionDir = path.join(__dirname, 'sessions', businessId)
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true })
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: require('pino')({ level: 'silent' })
    })

    sessions[businessId] = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            const qrImage = await qrcode.toDataURL(qr)
            qrCodes[businessId] = qrImage
            console.log(`📱 QR generado para negocio: ${businessId}`)
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            console.log(`❌ Conexión cerrada para ${businessId}, reconectar: ${shouldReconnect}`)
            if (shouldReconnect) {
                createSession(businessId)
            } else {
                delete sessions[businessId]
                delete qrCodes[businessId]
                fs.rmSync(sessionDir, { recursive: true, force: true })
            }
        }

        if (connection === 'open') {
            console.log(`✅ WhatsApp conectado para negocio: ${businessId}`)
            delete qrCodes[businessId]
        }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const msg of messages) {
            if (msg.key.fromMe) continue
            if (!msg.message) continue

            const from = msg.key.remoteJid
            const text = msg.message?.conversation || 
                         msg.message?.extendedTextMessage?.text || 
                         ''

            if (!text) continue

            console.log(`📩 Mensaje de ${from}: ${text}`)

            try {
                const response = await axios.post(`${BACKEND_URL}/api/v1/chat/internal`, {

                    business_id: businessId,
                    session_id: from,
                    message: text,
                    channel: 'whatsapp'
                })

                const reply = response.data.message
                await sock.sendMessage(from, { text: reply })
                console.log(`🤖 Respuesta enviada a ${from}`)
            } catch (error) {
                console.error('❌ Error procesando mensaje:', error.message)
            }
        }
    })

    return sock
}

async function loadExistingSessions() {
    const sessionsDir = path.join(__dirname, 'sessions')
    if (!fs.existsSync(sessionsDir)) {
        fs.mkdirSync(sessionsDir)
        return
    }
    const businessIds = fs.readdirSync(sessionsDir)
    for (const businessId of businessIds) {
        console.log(`🔄 Cargando sesión existente: ${businessId}`)
        await createSession(businessId)
    }
}

// Iniciar sesión
app.get('/session/:businessId/start', async (req, res) => {
    const { businessId } = req.params
    try {
        if (!sessions[businessId]) {
            await createSession(businessId)
        }
        res.json({ message: 'Sesión iniciada, esperando QR...' })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// Obtener QR
app.get('/session/:businessId/qr', async (req, res) => {
    const { businessId } = req.params

    if (!sessions[businessId]) {
        await createSession(businessId)
    }

    let attempts = 0
    while (!qrCodes[businessId] && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        attempts++
    }

    if (qrCodes[businessId]) {
        res.json({ qr: qrCodes[businessId], status: 'waiting_scan' })
    } else if (sessions[businessId]?.user) {
        res.json({ status: 'connected', message: 'WhatsApp ya está conectado' })
    } else {
        res.status(408).json({ error: 'Timeout esperando QR' })
    }
})

// Estado de la sesión
app.get('/session/:businessId/status', (req, res) => {
    const { businessId } = req.params
    const session = sessions[businessId]

    if (!session) {
        res.json({ status: 'disconnected' })
    } else if (session.user) {
        res.json({ status: 'connected', phone: session.user.id })
    } else if (qrCodes[businessId]) {
        res.json({ status: 'waiting_scan' })
    } else {
        res.json({ status: 'connecting' })
    }
})

// Cerrar sesión
app.delete('/session/:businessId', (req, res) => {
    const { businessId } = req.params
    if (sessions[businessId]) {
        sessions[businessId].logout()
        delete sessions[businessId]
        delete qrCodes[businessId]
    }
    res.json({ message: 'Sesión cerrada ✅' })
})

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', sessions: Object.keys(sessions).length })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, async () => {
    console.log(`🚀 WhatsApp Service corriendo en puerto ${PORT}`)
    await loadExistingSessions()
})