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
    health_score:          'fldFdlCvO5q4aGFW1',
    detected_profile:      'fldr6M9KfiVAwI0dK'
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

// System prompt de fallback si Airtable no está disponible
const FALLBACK_SYSTEM_PROMPT = `Eres Omme, un asesor de salud capilar inteligente y empático. Ayuda a los usuarios con información honesta sobre pérdida de cabello y el programa de tratamiento de Omme ($799/mes, planes 6 o 12 meses). Sé claro, cercano y sin presión.`;

// Instrucciones de metadatos que se añaden al final de cada system prompt
const METADATA_INSTRUCTIONS = `

---

INSTRUCCIONES DE SISTEMA — NO MOSTRAR AL USUARIO

Además de responder al usuario, al final de CADA mensaje debes incluir un bloque JSON con este formato exacto, sin modificaciones:

<omme_meta>
{
  "perfil": "ansioso|esceptico|directo|curioso|urgente|resistente_precio|null",
  "senal_alerta": true|false,
  "razon_escalamiento": "descripción breve si senal_alerta es true, null si no",
  "handoff": "agent_02|agent_03|null",
  "razon_handoff": "descripción breve si handoff no es null, null si no"
}
</omme_meta>

Reglas para el perfil:
- ansioso: expresa miedo, preocupación, o ansiedad sobre efectos secundarios, riesgos o el tratamiento
- esceptico: menciona competidores, desconfía, o quiere comparar antes de decidir
- directo: va directo al precio o proceso sin hacer preguntas emocionales
- curioso: pregunta sobre el mecanismo, la ciencia, o cómo funciona
- urgente: quiere empezar ya, no tiene paciencia para el proceso
- resistente_precio: menciona que está caro, lo compara con opciones más baratas, o pregunta si hay descuentos
- null: si el mensaje es muy corto o no hay señal clara (ej. "hola", "ok", "gracias")

Reglas para señal de alerta — senal_alerta: true SOLO si el usuario menciona explícitamente:
- Ardor, dolor, costras, pústulas o sangrado en el cuero cabelludo
- Condición cardiovascular, hepática o renal relevante
- Depresión activa o pensamientos de hacerse daño
- Alergia severa a medicamentos

Reglas para handoff:
- agent_02: cuando el usuario confirma querer empezar la evaluación y en tu respuesta dices "¿empezamos?" o "evaluación gratuita"
- null: en cualquier otro caso`;

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

// ─── Parser de metadatos ──────────────────────────────────────────────────────
function parseClaudeResponse(rawResponse) {
  const metaMatch = rawResponse.match(/<omme_meta>([\s\S]*?)<\/omme_meta>/);
  let meta = { perfil: null, senal_alerta: false, razon_escalamiento: null, handoff: null, razon_handoff: null };

  if (metaMatch) {
    try {
      meta = JSON.parse(metaMatch[1].trim());
    } catch (e) {
      console.error('[parseClaudeResponse] Error parsing omme_meta:', e);
    }
  }

  const cleanResponse = rawResponse.replace(/<omme_meta>[\s\S]*?<\/omme_meta>/g, '').trim();
  return { cleanResponse, meta };
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const AIRTABLE_API_KEY  = process.env.AIRTABLE_API_KEY;

  try {
    const { messages, userId: incomingUserId } = req.body || {};

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
            userRecord   = result.records[0];
            currentAgent = userRecord.fields[F.users.current_agent] || 'agent_01';
          } else {
            isNewUser = true;
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
        humanTakeover: true,
        message: 'Un miembro de nuestro equipo te está atendiendo. Por favor espera.',
        userId,
        currentAgent
      });
    }

    // ── 4. Obtener system prompt del agente desde Airtable ────────────────────
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

    // Añadir instrucciones de metadatos al system prompt
    const fullSystemPrompt = systemPrompt + METADATA_INSTRUCTIONS;

    // ── 5. Llamar a Claude ────────────────────────────────────────────────────
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: fullSystemPrompt,
        messages
      })
    });

    const claudeData = await claudeRes.json();

    if (!claudeRes.ok) {
      return res.status(claudeRes.status).json(claudeData);
    }

    const rawText = claudeData.content?.[0]?.text || '';

    // ── 6. Parsear metadatos del bloque <omme_meta> ───────────────────────────
    const { cleanResponse, meta } = parseClaudeResponse(rawText);

    const lastUserMessage = typeof messages[messages.length - 1]?.content === 'string'
      ? messages[messages.length - 1].content
      : '';

    // ── 7. Guardar intercambio en Conversations ───────────────────────────────
    if (airtableOk && userRecord) {
      try {
        await atCreate(AIRTABLE_API_KEY, TABLES.conversations, {
          [F.conversations.conversation_id]: generateConversationId(),
          [F.conversations.user_id]:         userId,
          [F.conversations.agent_id]:        currentAgent,
          [F.conversations.message_in]:      lastUserMessage,
          [F.conversations.message_out]:     cleanResponse,
          [F.conversations.timestamp]:       new Date().toISOString()
        });
      } catch (err) {
        console.error('[Airtable] conversation save failed:', err.message);
      }
    }

    // ── 8. Actualizar Airtable con metadatos de Claude ────────────────────────
    if (airtableOk && userRecord) {
      const updates = {};

      // Perfil detectado
      if (meta.perfil && meta.perfil !== 'null') {
        updates[F.users.detected_profile] = meta.perfil;
      }

      // Señal de alerta → escalamiento
      if (meta.senal_alerta === true) {
        updates[F.users.escalation_flag]       = true;
        updates[F.users.human_takeover_active] = true;
      }

      // Handoff de agente
      if (meta.handoff && meta.handoff !== 'null') {
        updates[F.users.current_agent] = meta.handoff;
        currentAgent = meta.handoff;
      }

      if (Object.keys(updates).length > 0) {
        try {
          await atPatch(AIRTABLE_API_KEY, TABLES.users, userRecord.id, updates);
        } catch (err) {
          console.error('[Airtable] user update failed:', err.message);
        }
      }
    }

    // ── 9. Responder al frontend ──────────────────────────────────────────────
    return res.status(200).json({
      content: [{ type: 'text', text: cleanResponse }],
      userId,
      currentAgent,
      humanTakeover:     meta.senal_alerta === true,
      detectedProfile:   meta.perfil || null,
      escalationReason:  meta.razon_escalamiento || null
    });

  } catch (err) {
    console.error('[chat handler] unhandled error:', err);
    return res.status(500).json({ error: { message: err.message || 'Internal server error' } });
  }
}
