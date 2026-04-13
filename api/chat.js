// ─── Constantes ────────────────────────────────────────────────────────────────
const BASE_ID = 'appMC1miPwTNWaZuK';

const TABLES = {
  users:         'tblEzoSPjKzedqlgh',
  agentPrompts:  'tblBdLAnu0MmDBZLn',
  conversations: 'tblwfeZBOCKQ96D1R'
};

const F = {
  users: {
    user_id:               'fldPPz3HHT1R2RmU1',
    current_agent:         'fldQdE1Ww6U3mF2bo',
    human_takeover_active: 'fldD7QvN3K6CHxLbE',
    escalation_flag:       'fldmCNPxQmln2Uew7',
    health_score:          'fldFdlCvO5q4aGFW1'
  },
  agentPrompts: {
    agent_id:      'fldP6vlaSBUt07HZX',
    system_prompt: 'fldNRYA048Vh3cJyf',
    active:        'fldfnWqxfaxUfK33y'
  },
  conversations: {
    conversation_id: 'fld6jZwr0KjugACbS',
    user_id:         'fldOqv8IswrVtaPvm',
    agent_id:        'fldYJlV6hR2L0jGFk',
    message_in:      'fldTCOqSpkEoKLGge',
    message_out:     'flduFcA5z8Rz9sU8A',
    timestamp:       'fld6RJbqEg9Sv350q'
  }
};

// Señales de alerta en el mensaje del usuario (disparan escalamiento ANTES de llamar a Claude)
const USER_ALERT_KEYWORDS = [
  'ardor', 'costras', 'pústulas', 'sangrado en el cuero cabelludo',
  'ataque al corazón', 'problema cardíaco', 'insuficiencia'
];

// Frase de alerta en la respuesta del agente (dispara escalamiento DESPUÉS de llamar a Claude)
const AGENT_ALERT_PHRASE = 'déjame conectarte con nuestro equipo médico';

// Señales de handoff agent_01 → agent_02
const HANDOFF_01_TRIGGERS = ['evaluación gratuita', '¿empezamos?', '¿empezamos'];

// System prompt de fallback si Airtable no está disponible
const FALLBACK_SYSTEM_PROMPT = `Eres Omme, un asesor de salud capilar inteligente y empático. Ayuda a los usuarios con información honesta sobre pérdida de cabello y el programa de tratamiento de Omme ($799/mes, planes 6 o 12 meses). Sé claro, cercano y sin presión.`;

// ─── Helpers de Airtable ──────────────────────────────────────────────────────
function airtableHeaders(apiKey) {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

async function atGet(apiKey, table, formula) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${table}?filterByFormula=${encodeURIComponent(formula)}&returnFieldsByFieldId=true`;
  const res = await fetch(url, { headers: airtableHeaders(apiKey) });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable GET ${table} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function atCreate(apiKey, table, fields) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: airtableHeaders(apiKey),
    body: JSON.stringify({ fields, typecast: true })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable POST ${table} → ${res.status}: ${body}`);
  }
  return res.json();
}

async function atPatch(apiKey, table, recordId, fields) {
  const url = `https://api.airtable.com/v0/${BASE_ID}/${table}/${recordId}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: airtableHeaders(apiKey),
    body: JSON.stringify({ fields, typecast: true })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable PATCH ${table}/${recordId} → ${res.status}: ${body}`);
  }
  return res.json();
}

function generateUserId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `usr_${Date.now()}_${rand}`;
}

function generateConversationId() {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const AIRTABLE_API_KEY  = process.env.AIRTABLE_API_KEY;

  try {
    const { messages, userId: incomingUserId, conversationHistory } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages array is required' } });
    }

    // ── 1. userId ─────────────────────────────────────────────────────────────
    let userId = incomingUserId || null;
    let isNewUser = !userId;
    if (isNewUser) userId = generateUserId();

    // ── 2. Consultar / crear usuario en Airtable ──────────────────────────────
    let userRecord   = null;
    let currentAgent = 'agent_01';
    let airtableOk   = !!AIRTABLE_API_KEY;

    if (airtableOk) {
      try {
        if (!isNewUser) {
          const result = await atGet(
            AIRTABLE_API_KEY,
            TABLES.users,
            `{${F.users.user_id}}='${userId}'`
          );
          if (result.records?.length > 0) {
            userRecord    = result.records[0];
            currentAgent  = userRecord.fields[F.users.current_agent] || 'agent_01';
          } else {
            isNewUser = true; // userId en localStorage pero no en Airtable
          }
        }

        if (isNewUser) {
          userRecord = await atCreate(AIRTABLE_API_KEY, TABLES.users, {
            [F.users.user_id]:               userId,
            [F.users.health_score]:          50,
            [F.users.current_agent]:         'agent_01',
            [F.users.human_takeover_active]: false,
            [F.users.escalation_flag]:       false
          });
          currentAgent = 'agent_01';
        }
      } catch (err) {
        console.error('[Airtable] user lookup/create failed:', err.message);
        airtableOk = false;
      }
    }

    // ── 3. human_takeover_active → respuesta inmediata ────────────────────────
    if (airtableOk && userRecord?.fields?.[F.users.human_takeover_active]) {
      return res.status(200).json({
        human_takeover: true,
        message: 'Un miembro de nuestro equipo te está atendiendo. Por favor espera.',
        userId,
        currentAgent
      });
    }

    // ── 4. Señales de alerta en el mensaje del usuario ────────────────────────
    const lastUserMessage = typeof messages[messages.length - 1]?.content === 'string'
      ? messages[messages.length - 1].content
      : '';

    const userHasAlert = USER_ALERT_KEYWORDS.some(kw =>
      lastUserMessage.toLowerCase().includes(kw.toLowerCase())
    );

    if (userHasAlert) {
      if (airtableOk && userRecord) {
        try {
          await atPatch(AIRTABLE_API_KEY, TABLES.users, userRecord.id, {
            [F.users.escalation_flag]:       true,
            [F.users.human_takeover_active]: true
          });
        } catch (err) {
          console.error('[Airtable] escalation update failed:', err.message);
        }
      }
      return res.status(200).json({
        human_takeover: true,
        message: 'Por la información que compartes, es importante que te atienda directamente nuestro equipo médico. Alguien te contactará en los próximos minutos.',
        userId,
        currentAgent
      });
    }

    // ── 5. Obtener system prompt del agente desde Airtable ────────────────────
    let systemPrompt = FALLBACK_SYSTEM_PROMPT;

    if (airtableOk) {
      try {
        const promptResult = await atGet(
          AIRTABLE_API_KEY,
          TABLES.agentPrompts,
          `AND({${F.agentPrompts.agent_id}}='${currentAgent}',{${F.agentPrompts.active}}=TRUE())`
        );
        if (promptResult.records?.length > 0) {
          const fetched = promptResult.records[0].fields[F.agentPrompts.system_prompt];
          if (fetched) systemPrompt = fetched;
        } else {
          console.warn(`[Airtable] No active prompt found for agent: ${currentAgent}`);
        }
      } catch (err) {
        console.error('[Airtable] system prompt fetch failed:', err.message);
      }
    }

    // ── 6. Llamar a Claude ────────────────────────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: systemPrompt,
        messages
      })
    });

    const claudeData = await claudeRes.json();

    if (!claudeRes.ok) {
      return res.status(claudeRes.status).json(claudeData);
    }

    const replyText = claudeData.content?.[0]?.text || '';

    // ── 7. Guardar intercambio en Conversations ───────────────────────────────
    if (airtableOk && userRecord) {
      try {
        await atCreate(AIRTABLE_API_KEY, TABLES.conversations, {
          [F.conversations.conversation_id]: generateConversationId(),
          [F.conversations.user_id]:         userId,
          [F.conversations.agent_id]:        currentAgent,
          [F.conversations.message_in]:      lastUserMessage,
          [F.conversations.message_out]:     replyText,
          [F.conversations.timestamp]:       new Date().toISOString()
        });
      } catch (err) {
        console.error('[Airtable] conversation save failed:', err.message);
      }
    }

    // ── 8. Detectar handoff en la respuesta ──────────────────────────────────
    if (airtableOk && userRecord) {
      let newAgent = null;

      if (currentAgent === 'agent_01') {
        const lower = replyText.toLowerCase();
        if (HANDOFF_01_TRIGGERS.some(t => lower.includes(t.toLowerCase()))) {
          newAgent = 'agent_02';
        }
      }
      // agent_02 → agent_03: por webhook de intake_completed (ver /api/intake-webhook)
      // agent_03 → agent_04: por webhook de Shopify (ver /api/shopify-webhook)

      if (newAgent) {
        try {
          await atPatch(AIRTABLE_API_KEY, TABLES.users, userRecord.id, {
            [F.users.current_agent]: newAgent
          });
          currentAgent = newAgent;
        } catch (err) {
          console.error('[Airtable] handoff update failed:', err.message);
        }
      }
    }

    // ── 9. Detectar señal de alerta en la respuesta del agente ────────────────
    if (airtableOk && userRecord && replyText.toLowerCase().includes(AGENT_ALERT_PHRASE)) {
      try {
        await atPatch(AIRTABLE_API_KEY, TABLES.users, userRecord.id, {
          [F.users.escalation_flag]:       true,
          [F.users.human_takeover_active]: true
        });
      } catch (err) {
        console.error('[Airtable] agent alert escalation failed:', err.message);
      }
    }

    // ── 10. Responder al frontend ─────────────────────────────────────────────
    return res.status(200).json({
      ...claudeData,
      userId,
      currentAgent
    });

  } catch (err) {
    console.error('[chat handler] unhandled error:', err);
    return res.status(500).json({ error: { message: err.message || 'Internal server error' } });
  }
}
