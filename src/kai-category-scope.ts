export interface DiscordCategoryChannel {
  id?: string;
  name?: string;
  type?: number;
  parent_id?: string;
  last_message_id?: string;
}

export interface KaiCategoryMonitorChannel {
  id: string;
  name: string;
  last_message_id?: string;
}

export function selectKaiCategoryMonitorChannels(
  guildChannels: DiscordCategoryChannel[],
  activeThreads: DiscordCategoryChannel[],
  categoryIds: Iterable<string>,
): KaiCategoryMonitorChannel[] {
  const scopedCategoryIds = new Set(categoryIds);
  const directChildren = guildChannels.filter(channel =>
    scopedCategoryIds.has(String(channel?.parent_id || ''))
  );
  const threadParents = new Set(directChildren
    .filter(channel => [0, 5, 15].includes(Number(channel?.type)))
    .map(channel => String(channel.id)));
  const eligible = [
    ...directChildren.filter(channel => [0, 5].includes(Number(channel?.type))),
    ...activeThreads.filter(thread =>
      [10, 11, 12].includes(Number(thread?.type))
      && threadParents.has(String(thread?.parent_id || ''))
    ),
  ];

  return [...new Map(eligible
    .filter(channel => /^\d+$/.test(String(channel?.id || '')))
    .map(channel => {
      const id = String(channel.id);
      const lastMessageId = String(channel.last_message_id || '');
      return [id, {
        id,
        name: String(channel.name || id),
        ...(/^\d+$/.test(lastMessageId) ? { last_message_id: lastMessageId } : {}),
      }] as const;
    })).values()];
}
