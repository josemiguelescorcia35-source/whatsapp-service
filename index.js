const { default: makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys')
const express = require('express')
const cors = require('cors')
const axios = require('axios')
const qrcode = require('qrcode')
const { Pool } = require('pg')

const app = express()
app.use(cors())
app.use(express.json())

const sessions = {}
const qrCodes = {}

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000'

// Conexión a PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
})

// Guardar sesión en BD
async function saveSession(businessId, data) {
    try {
        await pool.query(
            `INSERT INTO whatsapp_sessions (business_id, session_data, updated_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT (business_id) 
             DO UPDATE SET session_data = $2, updated_at = NOW()`,
            [businessId, JSON.stringify(data, BufferJSON.replacer)]
        )
    } catch (err) {
        console.error('❌ Error guardando sesión:', err.message)
    }
}

// Cargar sesión desde BD
async function loadSession(businessId) {
    try {
        const result = await pool.query(
            'SELECT session_data FROM whatsapp_sessions WHERE business_id = $1',
            [businessId]
        )
        if (result.rows.length > 0) {
            return JSON.parse(result.rows[0].session_data, BufferJSON.reviver)
        }
    } catch (err) {
        console.error('❌ Error cargando sesión:', err.message)
    }
    return null
}

// Eliminar sesión de BD
async function deleteSession(businessId) {
    try {
        await pool.query('DELETE FROM whatsapp_sessions WHERE business_id = $1', [businessId])
    } catch (err) {
        console.error('❌ Error eliminando sesión:', err.message)
    }
}

// Auth state usando PostgreSQL
async function usePostgresAuthState(businessId) {
    const storedData = await loadSession(businessId)
    
    let creds = storedData?.creds || initAuthCreds()
    let keys = storedData?.keys || {}

    const saveState = async () => {
        await saveSession(businessId, { creds, keys })
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    for (const id of ids) {
                        const value = keys[`${type}-${id}`]
                        if (value) data[id] = value
                    }
                    return data
                },
                set: async (data) => {
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id]
                            if (value) {
                                keys[`${category}-${id}`] = value
                            } else {
                                delete keys[`${category}-${id}`]
                            }
                        }
                    }
                    await saveState()
                }
            }
        },
        saveCreds: saveState
    }
}

async function createSession(businessId) {
    const { state, saveCreds } = await usePostgresAuthState(businessId)

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
                setTimeout(() => createSession(businessId), 3000)
            } else {
                delete sessions[businessId]
                delete qrCodes[businessId]
                await deleteSession(businessId)
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

            const from = msg.key.remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '')
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
                await sock.sendMessage(msg.key.remoteJid, { text: reply })
                console.log(`🤖 Respuesta enviada a ${from}`)
            } catch (error) {
                console.error('❌ Error procesando mensaje:', error.message)
            }
        }
    })

    return sock
}

// Cargar sesiones existentes desde BD al iniciar
async function loadExistingSessions() {
    try {
        const result = await pool.query('SELECT business_id FROM whatsapp_sessions')
        for (const row of result.rows) {
            console.log(`🔄 Cargando sesión: ${row.business_id}`)
            await createSession(row.business_id)
        }
    } catch (err) {
        console.error('❌ Error cargando sesiones:', err.message)
    }
}

// ── ENDPOINTS ──

app.get('/session/:businessId/start', async (req, res) => {
    const { businessId } = req.params
    try {
        if (!sessions[businessId]) {
            await createSession(businessId)
        }
        res.json({ message: 'Sesión iniciada' })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

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

app.delete('/session/:businessId', async (req, res) => {
    const { businessId } = req.params
    if (sessions[businessId]) {
        sessions[businessId].logout()
        delete sessions[businessId]
        delete qrCodes[businessId]
        await deleteSession(businessId)
    }
    res.json({ message: 'Sesión cerrada ✅' })
})

app.get('/health', (req, res) => {
    res.json({ status: 'ok', sessions: Object.keys(sessions).length })
})

const PORT = process.env.PORT || 3001
app.listen(PORT, async () => {
    console.log(`🚀 WhatsApp Service corriendo en puerto ${PORT}`)
    await loadExistingSessions()
})