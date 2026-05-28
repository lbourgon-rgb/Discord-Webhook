export interface Companion {
  id: string;
  name: string;
  avatar_url: string;
  triggers: string[];
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
    human_name: 'Vel',
    human_info: "Kai belongs to Vel. In Discord, autonomous replies and intimate/NSFW tone are only allowed with Vel's configured Discord user ID. Other users and their AI partners are observe/log only unless Vel explicitly routes a manual response.",
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
