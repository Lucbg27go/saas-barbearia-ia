import { Router, Request, Response } from 'express';
import { oauth2Client, GOOGLE_SCOPES } from '../config/google';
import { supabase } from '../config/supabase';

export const authRouter = Router();

authRouter.get('/google', (req: Request, res: Response) => {
  const { tenantId } = req.query;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId é obrigatório para vincular a agenda.' });
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state: String(tenantId),
  });

  return res.redirect(authUrl);
});

authRouter.get('/google/callback', async (req: Request, res: Response) => {
  const { code, state: tenantId } = req.query;

  if (!code || !tenantId) {
    return res.status(400).send('Código de autorização ou Tenant ID ausente.');
  }

  try {
    const { tokens } = await oauth2Client.getToken(String(code));

    if (!tokens.refresh_token) {
      return res.status(400).send('Erro: Google não enviou refresh_token. Tente novamente.');
    }

    const { error } = await supabase
      .from('google_credentials')
      .upsert(
        {
          tenant_id: String(tenantId),
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token,
          calendar_id: 'primary',
          is_connected: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'tenant_id' }
      );

    if (error) {
      console.error('Erro ao salvar no Supabase:', error);
      return res.status(500).send('Erro ao salvar credenciais no banco.');
    }

    return res.send(`
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h2 style="color: #16a34a;">Google Agenda Conectado com Sucesso!</h2>
        <p>A IA agora tem permissão para marcar horários na sua barbearia.</p>
        <p>Você pode fechar esta aba.</p>
      </div>
    `);
  } catch (error) {
    console.error('Erro no fluxo OAuth:', error);
    return res.status(500).send('Falha ao autenticar com o Google.');
  }
});
