export const MONA_CLIPS = [
  'mona-idle', 'mona-thinking', 'mona-tool', 'mona-pr',
  'mona-done', 'mona-workflow', 'mona-security', 'mona-offline'
];
const KIND_MOODS = {
  prAssigned: 'prAssigned', reviewRequested: 'reviewRequested', workflowFailure: 'workflowFailure',
  workflowUpdate: 'workflowFailure', githubNotification: 'needsInput',
  securityAlert: 'securityAlert', criticalSecurity: 'securityAlert',
  pr: 'reviewRequested', workflow: 'workflowFailure', security: 'securityAlert',
  monaIdle: 'idle', monaThinking: 'thinking', monaTool: 'tool', monaDone: 'done',
  monaScared: 'scared', monaOffline: 'disconnected'
};
const MOOD_CLIPS = {
  idle: 'mona-idle', thinking: 'mona-thinking', tool: 'mona-tool', needsInput: 'mona-pr',
  done: 'mona-done', error: 'mona-workflow', scared: 'mona-security', disconnected: 'mona-offline',
  prAssigned: 'mona-pr', reviewRequested: 'mona-pr', workflowFailure: 'mona-workflow', securityAlert: 'mona-security'
};
const CLIP_DEFAULT_MOODS = {
  'mona-idle': 'idle', 'mona-thinking': 'thinking', 'mona-tool': 'tool', 'mona-pr': 'prAssigned',
  'mona-done': 'done', 'mona-workflow': 'workflowFailure', 'mona-security': 'securityAlert', 'mona-offline': 'disconnected'
};
const MOOD_KINDS = {
  prAssigned: 'prAssigned', reviewRequested: 'reviewRequested', workflowFailure: 'workflowFailure',
  securityAlert: 'securityAlert', scared: 'monaScared', monaIdle: 'monaIdle', monaThinking: 'monaThinking',
  monaTool: 'monaTool', monaDone: 'monaDone', monaOffline: 'monaOffline'
};
const CLIP_KINDS = {
  'mona-idle': 'monaIdle', 'mona-thinking': 'monaThinking', 'mona-tool': 'monaTool',
  'mona-pr': 'reviewRequested', 'mona-done': 'monaDone', 'mona-workflow': 'workflowFailure',
  'mona-security': 'criticalSecurity', 'mona-offline': 'monaOffline'
};

export function presentation(state, catalog: any = {}) {
  const mascot = state.mascot === 'mona' ? 'mona' : 'copilot';
  let mood = state.mood || 'idle';
  let clip = state.clip;
  if (mascot === 'mona') {
    if (mood !== 'disconnected') {
      const fromKind = KIND_MOODS[state.alert?.kind];
      const validClip = MONA_CLIPS.includes(clip) ? clip : undefined;
      if (fromKind) {
        mood = fromKind;
      } else if (validClip && (mood === 'idle' || mood === 'needsInput' || mood === 'error' || MOOD_CLIPS[mood] !== validClip)) {
        mood = CLIP_DEFAULT_MOODS[validClip] ?? 'reviewRequested';
      } else if (mood === 'idle' || mood === 'needsInput' || mood === 'error' || !MOOD_CLIPS[mood]) {
        mood = 'reviewRequested';
      }
    }
  }
  const definition = catalog?.[mascot]?.[mood];
  if (mascot === 'mona') {
    clip = MONA_CLIPS.includes(clip) ? clip : definition?.animation ?? MOOD_CLIPS[mood] ?? 'mona-pr';
  } else {
    mood = state.mood || 'idle';
    clip = definition?.animation ?? mood;
  }
  const selected = mascot === 'mona' && !MONA_CLIPS.includes(clip) ? 'mona-pr' : clip;
  const alertTask = state.alert?.kind === 'githubNotification' ? 'GitHub needs attention' : undefined;
  const fallbackTask = mascot === 'mona'
    ? {
        idle: 'Resting', thinking: 'Working', tool: 'Executing', needsInput: 'Input needed',
        done: 'Done', error: 'Error', scared: 'Scared', disconnected: 'Offline',
        prAssigned: 'PR assigned', reviewRequested: 'PR needs review',
        workflowFailure: 'Workflow failed', securityAlert: 'Security alert'
      }[mood]
    : { idle: 'Resting', thinking: 'Working', tool: 'Executing', needsInput: 'Input needed', done: 'Done', error: 'Error', disconnected: 'Offline' }[mood];
  return {
    ...state, mascot, clip: selected, mood,
    task: mood === 'disconnected' ? 'Offline' : state.task ?? alertTask ??
      (mood === 'tool' && state.tool ? state.tool : definition?.task ?? fallbackTask),
    ring: mood === 'disconnected' ? catalog?.copilot?.disconnected?.ring : state.ring ?? definition?.ring,
    presentationId: Number.isSafeInteger(state.presentationId) && state.presentationId >= 0 ? state.presentationId : 0,
    sessions: state.sessions ?? []
  };
}

export function presentationChanged(previous, next) {
  return previous.mascot !== next.mascot || previous.clip !== next.clip || previous.mood !== next.mood ||
    previous.task !== next.task || JSON.stringify(previous.ring) !== JSON.stringify(next.ring) ||
    next.presentationId > previous.presentationId;
}

export function alertLabel(state) {
  if (state.task) return state.task;
  if (state.alert?.kind === 'prAssigned') return 'PR assigned';
  if (state.alert?.kind === 'monaScared') return 'Scared';
  return {
    'mona-idle': 'Resting',
    'mona-thinking': 'Working',
    'mona-tool': 'Executing',
    'mona-pr': 'PR needs review',
    'mona-done': 'Done',
    'mona-workflow': 'Workflow failed',
    'mona-security': 'Security alert',
    'mona-offline': 'Offline'
  }[state.clip] ?? 'GitHub alert';
}

export function githubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password &&
      (!url.port || url.port === '443') ? url.href : null;
  } catch { return null; }
}

export function renderNews(element, state) {
  const alert = state.mascot === 'mona' ? state.alert : null;
  element.hidden = !alert;
  element.textContent = '';
  element.removeAttribute('href');
  element.rel = 'noopener noreferrer';
  if (!alert) return;
  const title = typeof alert.title === 'string' ? alert.title.slice(0, 120) : alertLabel(state);
  const repository = typeof alert.repository === 'string' ? alert.repository.slice(0, 80) : '';
  const organization = typeof alert.organization === 'string' ? alert.organization.slice(0, 40) : '';
  const owner = typeof alert.owner === 'string' ? alert.owner.slice(0, 40) : repository.split('/')[0] || '';
  const repositoryName = typeof alert.repositoryName === 'string'
    ? alert.repositoryName.slice(0, 40)
    : repository.split('/').at(-1) || '';
  const ownerLabel = organization ? `Organization: ${organization}` : owner ? `Owner: ${owner}` : '';
  element.textContent = [alertLabel(state), ownerLabel, repositoryName && `Repository: ${repositoryName}`, title]
    .filter(Boolean).join(' · ');
  const href = githubUrl(alert.url);
  if (href) element.href = href;
}

export function previewState(live, mascot, clip, mood, id, catalog: any = {}) {
  if (!mascot && !mood) return presentation(live, catalog);
  const selected = mascot || 'copilot';
  const kind = MOOD_KINDS[mood] ?? CLIP_KINDS[clip] ?? 'reviewRequested';
  return presentation({
    ...live, mascot: selected, clip,
    task: undefined, ring: undefined,
    mood: mood || (selected === 'mona' ? 'needsInput' : live.mood || 'idle'), presentationId: id,
    alert: selected === 'mona' ? {
      id: `preview-${id}`, kind, title: alertLabel({ clip }),
      repository: 'octo-org/example', owner: 'octo-org', organization: 'octo-org',
      repositoryName: 'example', url: 'https://github.com/octo-org/example'
    } : undefined
  }, catalog);
}