'use strict';

const MANUAL_HANDOFF_CODES = new Set([
  'MANUAL_STEP_REQUIRED'
]);

function safeFileSummaries(files) {
  return Array.isArray(files)
    ? files.map((file) => {
        const safe = {};
        for (const key of [
          'role',
          'basename',
          'extension',
          'mimeType',
          'bytes',
          'sha256',
          'width',
          'height',
          'hasAlpha',
          'ruleset',
          'ok'
        ]) {
          if (file && file[key] !== undefined) {
            safe[key] = file[key];
          }
        }
        return safe;
      })
    : [];
}

function buildManualHandoffHints(error = {}) {
  if (!MANUAL_HANDOFF_CODES.has(error.code)) {
    return null;
  }

  const resumePolicy = error.resumePolicy || 'manual-step';
  const fileSummaries = safeFileSummaries(error.fileSummaries);
  return {
    category: 'manual-handoff',
    manualStepKind: error.manualStep && error.manualStep.kind
      ? error.manualStep.kind
      : 'file-picker',
    resumePolicy,
    origin: error.origin || null,
    uploadTarget: error.uploadTarget || null,
    fileSummaries,
    nextActions: [
      {
        kind: 'manual-file-picker',
        uploadTarget: error.uploadTarget || null,
        fileSummaries,
        requiresUserGesture: true,
        instruction: 'Use Chrome to complete the file picker or upload widget with the listed files. Do not send local file paths through chat.'
      },
      {
        kind: 'reobserve',
        origin: error.origin || null,
        freshObservationRequired: true,
        operatorCli: error.origin ? ['observe', error.origin] : null,
        toolName: error.origin ? 'codex_chrome_observe' : null,
        arguments: error.origin ? { origin: error.origin } : null
      },
      {
        kind: 'retry-original-tool',
        requiresOriginalArguments: true,
        instruction: 'Retry the original upload command only if the page still needs operator-side verification.'
      }
    ]
  };
}

module.exports = {
  buildManualHandoffHints,
  safeFileSummaries
};
