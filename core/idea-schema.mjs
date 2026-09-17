const fields = ['title', 'problem', 'benefit', 'scope', 'successCriteria', 'effort', 'evidence', 'whyNow'];
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid fields');
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid bounded text');
  return value.trim();
}
export function validateIdeation(config) {
  const keys = ['enabled', 'backlogCap', 'batchSize', 'minimumIntervalHours', 'ideaLabel', 'proposedState', 'approvedState', 'rejectedState'];
  object(config, keys);
  if (config.enabled !== true) throw new Error('Ideation must be enabled');
  for (const [key, max] of [['backlogCap', 50], ['batchSize', 10], ['minimumIntervalHours', 168]]) {
    if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > max) throw new Error(`Invalid ${key}`);
  }
  if (config.batchSize > config.backlogCap) throw new Error('Batch exceeds backlog cap');
  const result = { ...config };
  for (const key of ['ideaLabel', 'proposedState', 'approvedState', 'rejectedState']) result[key] = text(config[key], 80);
  if (new Set([result.proposedState, result.approvedState, result.rejectedState]).size !== 3) throw new Error('Ideation states must be distinct');
  return result;
}
export function validateProposals(proposals, limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Array.isArray(proposals) || proposals.length > limit) throw new Error('Invalid proposal limit');
  const titles = new Set();
  return proposals.map(proposal => {
    object(proposal, fields);
    if (Object.keys(proposal).length !== fields.length) throw new Error('Missing proposal fields');
    const result = {};
    for (const [key, max] of [['title', 160], ['problem', 800], ['benefit', 600], ['scope', 1200], ['whyNow', 600]]) result[key] = text(proposal[key], max);
    for (const key of ['successCriteria', 'evidence']) {
      if (!Array.isArray(proposal[key]) || !proposal[key].length || proposal[key].length > 6) throw new Error(`Invalid ${key}`);
      result[key] = proposal[key].map(value => text(value, 400));
    }
    if (!['S', 'M', 'L'].includes(proposal.effort)) throw new Error('Invalid effort');
    result.effort = proposal.effort;
    const title = result.title.normalize('NFKC').toLowerCase();
    if (titles.has(title)) throw new Error('Duplicate proposal title');
    titles.add(title);
    return result;
  });
}
