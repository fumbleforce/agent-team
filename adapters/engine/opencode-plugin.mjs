import { readFileSync } from 'node:fs';

function sharedConfiguration() {
  const config = JSON.parse(readFileSync(new URL('../../roles.json', import.meta.url), 'utf8'));
  const preferences = readFileSync(new URL('../../OWNER_PREFERENCES.md', import.meta.url), 'utf8');
  for (const agent of Object.values(config.agent)) {
    const match = /^\{file:\.\/(agents\/[\w-]+\.md)\}$/.exec(agent.prompt);
    if (!match) throw new Error('Invalid shared agent prompt path');
    agent.prompt = `${preferences}\n\n${readFileSync(new URL(`../../${match[1]}`, import.meta.url), 'utf8')}`;
  }
  return { agent: config.agent, command: config.command };
}

export default async function () {
  return {
    config(config) {
      const shared = sharedConfiguration();
      config.agent = { ...shared.agent, ...config.agent };
      config.command = { ...shared.command, ...config.command };
    }
  };
}
