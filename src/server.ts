import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { authRouter } from './routes/auth.routes';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/auth', authRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'online', service: 'SaaS Barbearia IA' });
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
