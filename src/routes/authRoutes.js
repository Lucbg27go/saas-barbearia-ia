const express = require('express');
const router = express.Router();
const { getGoogleAuthUrl, handleGoogleCallback } = require('../services/calendarService');

router.get('/google', (req, res) => {
  const tenantId = req.query.tenantId || '77585100-be4d-4e4d-b44b-ffc8f0ce6df1';
  const authUrl = getGoogleAuthUrl(tenantId);
  res.redirect(authUrl);
});

router.get('/google/callback', async (req, res) => {
  const { code, state: tenantId } = req.query;

  if (!code) {
    return res.status(400).send('Código de autorização não fornecido.');
  }

  try {
    await handleGoogleCallback(code, tenantId);
    res.send(`
      <div style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f172a; color: #f8fafc; min-height: 100vh;">
        <h1 style="color: #10b981;">✅ Integração Concluída!</h1>
        <p>A Google Agenda foi conectada com sucesso ao BarberAI.</p>
        <p>Você pode fechar esta aba e voltar para o sistema.</p>
      </div>
    `);
  } catch (error) {
    console.error('Erro no callback do Google:', error);
    res.status(500).send('Erro ao autenticar com o Google: ' + error.message);
  }
});

module.exports = router;
