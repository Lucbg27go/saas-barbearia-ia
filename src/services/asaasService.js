const axios = require('axios');

const ASAAS_API_URL = process.env.ASAAS_API_URL || 'https://sandbox.asaas.com/api/v3';
const ASAAS_API_KEY = process.env.ASAAS_API_KEY;

const asaasClient = axios.create({
  baseURL: ASAAS_API_URL,
  headers: {
    'Content-Type': 'application/json',
    access_token: ASAAS_API_KEY,
  },
});

// Cria (ou reaproveita) o cliente na Asaas
async function createOrGetCustomer({ name, email, cpfCnpj, phone }) {
  const { data } = await asaasClient.post('/customers', {
    name,
    email,
    cpfCnpj,
    mobilePhone: phone || undefined,
  });
  return data; // contém data.id
}

// Cria a assinatura mensal recorrente, com primeira cobrança alinhada ao fim do trial
async function createSubscription({ customerId, value, nextDueDate, description }) {
  const { data } = await asaasClient.post('/subscriptions', {
    customer: customerId,
    billingType: 'UNDEFINED', // deixa o cliente escolher PIX ou cartão na hora de pagar
    value,
    nextDueDate, // formato 'YYYY-MM-DD'
    cycle: 'MONTHLY',
    description: description || 'Assinatura BarberAI',
  });
  return data; // contém data.id (subscriptionId)
}

// Busca a primeira cobrança gerada pela assinatura, pra pegar o link de pagamento
async function getFirstPaymentLink(subscriptionId) {
  const { data } = await asaasClient.get('/payments', {
    params: { subscription: subscriptionId, limit: 1 },
  });
  const payment = data?.data?.[0];
  return payment?.invoiceUrl || null;
}

module.exports = {
  createOrGetCustomer,
  createSubscription,
  getFirstPaymentLink,
};
