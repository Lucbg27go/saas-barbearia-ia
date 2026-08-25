const express = require('express');
const router = express.Router();
const { handleCustomerChat } = require('../services/aiAgent');

router.post('/test', async (req, res) => {
  try {
    const { tenantId, customerName, customerPhone, message } = req.body;
    const response = await handleCustomerChat(tenantId, customerPhone, customerName, message);
    res.json({ response });
  } catch (error) {
    console.error('Erro na rota de teste de chat:', error);
    res.status(500).json({ error: error.message || error });
  }
});

module.exports = router;
