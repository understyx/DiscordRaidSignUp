'use strict';

const LINK_PREVIEW_USER_AGENT =
  /Discordbot|Slackbot|Twitterbot|facebookexternalhit|LinkedInBot|TelegramBot|WhatsApp/i;
const LEGACY_GUILD_PATH = /^\/raids\/(\d{17,19})(?:\/|$)/;

function isLinkPreviewRequest(req) {
  if (!req || !['GET', 'HEAD'].includes(req.method)) return false;
  return LINK_PREVIEW_USER_AGENT.test(String(req.get('user-agent') || ''));
}

function guildIdFromRaidPath(pathname) {
  const match = LEGACY_GUILD_PATH.exec(String(pathname || ''));
  return match ? match[1] : null;
}

function hasCustomEmbed(embed) {
  return Boolean(embed && (embed.title || embed.description || embed.image_url || embed.color));
}

function buildLinkEmbed(guild, url) {
  const configured = guild.custom_embed || {};
  const guildName = guild.guild_name || 'Guild';

  return {
    title: configured.title || `${guildName} Raids`,
    description: configured.description || 'View upcoming raids and sign up with your characters.',
    image_url: configured.image_url || null,
    color: configured.color ? String(configured.color).replace(/^#/, '') : null,
    site_name: guildName,
    url,
  };
}

module.exports = {
  buildLinkEmbed,
  guildIdFromRaidPath,
  hasCustomEmbed,
  isLinkPreviewRequest,
};
