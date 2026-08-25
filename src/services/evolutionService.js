const axios = require('axios');

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

async function sendWhatsAppMessage(instanceName, number, textMessage) {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) {
    console.warn('[Evolution API] Variáveis EVOLUTION_API_URL ou EVOLUTION_API_KEY não configuradas.');
    return;
  }

  // Sanitiza o número removendo caracteres não numéricos
  const cleanNumber = number.replace(/\D/g, '');

  try {
    const response = await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${instanceName}`,
      {
        number: cleanNumber,
        options: {
          delay: 1200,
          presence: 'composing',
          linkPreview: false,
        },
        textMessage: {
          text: textMessage,
        },
      },
      {
        headers: {
          apikey: EVOLUTION_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error('[Evolution API] Erro ao enviar mensagem:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { sendWhatsAppMessage };
