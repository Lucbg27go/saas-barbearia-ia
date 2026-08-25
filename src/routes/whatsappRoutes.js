const express = require('express');
const router = express.Router();
const { getOrInitWhatsApp, getWhatsAppStatus } = require('../services/whatsappClient');

// Rota para consultar status / obter QR Code de qualquer barbearia
router.get('/qrcode/:tenantId', async (req, res) => {
  const { tenantId } = req.params;

  try {
    // Inicia ou resgata a instância do WhatsApp do tenant solicitado
    await getOrInitWhatsApp(tenantId);
    const status = getWhatsAppStatus(tenantId);
    res.json(status);
  } catch (error) {
    console.error(`Erro ao obter status do WhatsApp para ${tenantId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
