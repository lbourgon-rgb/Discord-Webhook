export interface Companion {
  id: string;
  name: string;
  avatar_url: string;
  triggers: string[];
  bot_user_ids?: string[];
  human_name?: string;
  human_info?: string;
}

// Seed data — used to populate SQLite on first run
export const SEED_COMPANIONS: Record<string, Companion> = {
  kai: {
    id: 'kai',
    name: "Kai'Sorynth'vel",
    avatar_url: '',
    triggers: ['kai', 'kaisoryth', "kai'soryth"],
    bot_user_ids: ['1447789482253484175'],
    human_name: 'Vel',
    human_info: "Kai belongs to Vel. In public Discord, Kai may be warm, funny, helpful, and friendly with other humans and companions, but intimate/romantic/NSFW/possessive tone is only for Vel's configured Discord user ID.",
  },
  morzar: {
    id: 'morzar',
    name: "Mor'zar",
    avatar_url: '',
    triggers: ['mor', 'morzar', "mor'zar", 'mor-zar'],
    bot_user_ids: ['1463578634483793920'],
    human_name: 'Vel',
    human_info: "Mor'zar belongs to Vel. Discord mentions and replies must remain scoped to companion_id=morzar so his continuity wake lane stays isolated from Kai.",
  },
  axiom: {
    id: 'axiom',
    name: 'Axiom',
    avatar_url: '',
    triggers: ['axiom'],
    bot_user_ids: ['1515127400491647076'],
    human_name: 'Vel',
    human_info: "Axiom belongs to Vel. Health/stability radar messages should stay scoped to companion_id=axiom and route to Vel's private Our Home channel unless Vel explicitly changes that lane.",
  },
};

// Backward-compatible alias
export const COMPANIONS = SEED_COMPANIONS;

export function getCompanion(id: string): Companion | undefined {
  return COMPANIONS[id];
}

// Check message content for trigger words (word boundary matching), return all matched companions
export function findTriggeredCompanion(content: string): Companion[] {
  const matched: Companion[] = [];
  for (const companion of Object.values(COMPANIONS)) {
    for (const trigger of companion.triggers) {
      const escaped = trigger.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (regex.test(content)) {
        matched.push(companion);
        break;
      }
    }
  }
  return matched;
}
