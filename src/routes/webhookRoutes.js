const express = require('express');
const router = express.Router();
const { handleCustomerChat } = require('../services/aiAgent');
const { sendWhatsAppMessage } = require('../services/evolutionService');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

router.post('/evolution', async (req, res) => {
  // Retorna 200 imediatamente para o webhook não expirar
  res.status(200).json({ status: 'received' });

  const body = req.body;

  try {
    // Valida se é um evento de mensagem recebida
    if (body.event !== 'messages.upsert') return;

    const data = body.data;
    const key = data?.key;

    // Ignora mensagens enviadas pelo próprio bot ou de grupos
    if (!key || key.fromMe || key.remoteJid.includes('@g.us')) return;

    const senderPhone = key.remoteJid.split('@')[0];
    const customerName = data.pushName || 'Cliente';
    const messageContent =
      data.message?.conversation ||
      data.message?.extendedTextMessage?.text;

    if (!messageContent || !messageContent.trim()) return;

    const instanceName = body.instance;

    // Busca o tenant associado a essa instância do WhatsApp
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('evolution_instance_name', instanceName)
      .single();

    // Fallback: usa o tenant de teste caso não localize pela instância
    const tenantId = tenant?.id || '77585100-be4d-4e4d-b44b-ffc8f0ce6df1';

    console.log(`[Webhook] Mensagem de ${customerName} (${senderPhone}): "${messageContent}"`);

    // Processa a resposta com o agente de IA
    const aiReply = await handleCustomerChat(tenantId, senderPhone, customerName, messageContent);

    console.log(`[Webhook] Resposta IA: "${aiReply}"`);

    // Envia a resposta de volta ao WhatsApp
    await sendWhatsAppMessage(instanceName, senderPhone, aiReply);
  } catch (error) {
    console.error('[Webhook] Erro no processamento:', error);
  }
});

module.exports = router;
