'use strict';

const ADAPTER_PROTOCOL_VERSION = '1.0';
const TOOL_SCHEMA_VERSION = '2026-05-01.m1';

const READ_PAGE_PROPERTIES = {
  origin: { type: 'string' },
  filter: { type: 'string' },
  depth: { type: 'number', minimum: 0 },
  maxChars: { type: 'number', minimum: 1 },
  refId: { type: 'string' },
  includeFormValues: { type: 'boolean' },
  maxFieldValueChars: { type: 'number', minimum: 0 }
};

const OBSERVE_OPTION_PROPERTIES = {
  mode: {
    type: 'string',
    enum: ['tiny', 'medium', 'full']
  },
  maxActionableHandles: { type: 'number', minimum: 1 },
  summaryMaxChars: { type: 'number', minimum: 1 },
  sincePageStateId: { type: 'string' },
  includeFormValues: { type: 'boolean' },
  maxFieldValueChars: { type: 'number', minimum: 0 }
};

const BATCH_OBSERVE_OPTION_PROPERTIES = {
  mode: OBSERVE_OPTION_PROPERTIES.mode,
  maxActionableHandles: OBSERVE_OPTION_PROPERTIES.maxActionableHandles,
  summaryMaxChars: OBSERVE_OPTION_PROPERTIES.summaryMaxChars,
  sincePageStateId: OBSERVE_OPTION_PROPERTIES.sincePageStateId,
  includeFormValues: OBSERVE_OPTION_PROPERTIES.includeFormValues,
  maxFieldValueChars: OBSERVE_OPTION_PROPERTIES.maxFieldValueChars
};

const POST_ACTION_SNAPSHOT_PROPERTIES = {
  postActionSnapshot: {
    type: 'string',
    enum: ['delta']
  },
  sincePageStateId: { type: 'string' },
  mode: OBSERVE_OPTION_PROPERTIES.mode,
  maxActionableHandles: OBSERVE_OPTION_PROPERTIES.maxActionableHandles,
  summaryMaxChars: OBSERVE_OPTION_PROPERTIES.summaryMaxChars
};

const VISUAL_OBSERVE_PROPERTIES = {
  origin: { type: 'string' },
  ...OBSERVE_OPTION_PROPERTIES,
  maxBytes: { type: 'number', minimum: 1 },
  reason: { type: 'string' }
};

const BATCH_ACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    handle: { type: 'string' },
    text: { type: 'string' },
    value: { type: 'string' },
    checked: { type: 'boolean' },
    deltaX: { type: 'number' },
    deltaY: { type: 'number' },
    key: { type: 'string' },
    condition: { type: 'string' },
    timeoutMs: { type: 'number', minimum: 0 },
    pollIntervalMs: { type: 'number', minimum: 1 },
    filter: { type: 'string' },
    depth: { type: 'number', minimum: 0 },
    maxChars: { type: 'number', minimum: 1 },
    refId: { type: 'string' },
    ...BATCH_OBSERVE_OPTION_PROPERTIES,
    postActionSnapshot: POST_ACTION_SNAPSHOT_PROPERTIES.postActionSnapshot
  },
  required: ['action']
};

const TOOL_DEFINITIONS = [
  {
    name: 'codex_chrome_status',
    description: 'Return local Chrome operator daemon status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        detail: {
          type: 'string',
          enum: ['compact', 'full']
        }
      },
      required: []
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_prepare_origin',
    description: 'Start the operator if needed, approve the origin locally, and return readiness plus user-grant next actions.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        openBootstrap: { type: 'boolean' }
      },
      required: ['origin']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_readiness',
    description: 'Verify whether an origin is ready for Codex-first observation and action.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' }
      },
      required: ['origin']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_profile_doctor',
    description: 'Diagnose daemon, configured Chrome profile, active tab, and readiness state for the optional origin.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' }
      },
      required: []
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_profile_onboard',
    description: 'Discover, bind, launch setup, and verify the Chrome profile that owns this operator session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        userDataDir: { type: 'string' },
        profileDirectory: { type: 'string' },
        profileLabel: { type: 'string' },
        openBootstrap: { type: 'boolean' }
      },
      required: []
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_open_observe',
    description: 'Prepare an origin, open a URL in Chrome, wait for the tab, and return a DOM observation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', format: 'uri' },
        timeoutMs: { type: 'number', minimum: 0 },
        pollIntervalMs: { type: 'number', minimum: 1 },
        ...OBSERVE_OPTION_PROPERTIES
      },
      required: ['url']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_observe',
    description: 'Return a DOM observation for an approved active tab origin.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        ...OBSERVE_OPTION_PROPERTIES
      },
      required: ['origin']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_read_page',
    description: 'Return compact accessibility-like page text for an approved active tab origin.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: READ_PAGE_PROPERTIES,
      required: ['origin']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_extract',
    description: 'Return an intent-scoped extraction for an approved active tab without generic DOM or page-content dumps.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        intent: { type: 'string' },
        maxCandidates: { type: 'number', minimum: 1 }
      },
      required: ['origin', 'intent']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_batch',
    description: 'Run a guarded batch of low-risk page read and DOM actions as one extension command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        actions: {
          type: 'array',
          minItems: 1,
          items: BATCH_ACTION_SCHEMA
        },
        stopOnError: { type: 'boolean' }
      },
      required: ['origin', 'actions']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_visual_observe',
    description: 'Return a visual observation with screenshot artifact references, not raw image bytes. Use only when DOM confidence is low or visual verification is needed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: VISUAL_OBSERVE_PROPERTIES,
      required: ['origin']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_visual_analyze',
    description: 'Analyze the approved active tab visually through the daemon, returning untrusted structured analysis.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        provider: { type: 'string' },
        maxBytes: { type: 'number' },
        allowSensitive: { type: 'boolean' }
      },
      required: ['origin']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_upload_file',
    description: 'Upload guarded draft-only files to an approved page file input handle, returning redacted file references.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        ruleset: { type: 'string' },
        verifyPreview: { type: 'boolean' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              role: { type: 'string' },
              path: { type: 'string' },
              expectedSha256: { type: 'string' }
            },
            required: ['role', 'path']
          }
        }
      },
      required: ['origin', 'handle', 'files']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_cart_prepare',
    description: 'Prepare an e-commerce cart from product search criteria only; stop before checkout/payment and never place orders.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        profileId: { type: 'string' },
        query: { type: 'string' },
        criteria: {
          type: 'object',
          additionalProperties: false,
          properties: {
            minSellerRating: { type: 'number' },
            maxPrice: { type: 'number' },
            currency: { type: 'string' },
            sort: { type: 'string' }
          },
          required: []
        },
        cartActionAllowed: { type: 'boolean' }
      },
      required: ['origin', 'query', 'cartActionAllowed']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_fill',
    description: 'Fill an approved page element handle.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        text: { type: 'string' },
        ...POST_ACTION_SNAPSHOT_PROPERTIES
      },
      required: ['origin', 'handle', 'text']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_type',
    description: 'Type text into an approved page element handle.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        text: { type: 'string' },
        ...POST_ACTION_SNAPSHOT_PROPERTIES
      },
      required: ['origin', 'handle', 'text']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_clear',
    description: 'Clear an approved text input or editable element handle.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        ...POST_ACTION_SNAPSHOT_PROPERTIES
      },
      required: ['origin', 'handle']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_focus',
    description: 'Focus an approved page element handle.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        ...POST_ACTION_SNAPSHOT_PROPERTIES
      },
      required: ['origin', 'handle']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_select',
    description: 'Select an option value on an approved select element handle.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        value: { type: 'string' },
        ...POST_ACTION_SNAPSHOT_PROPERTIES
      },
      required: ['origin', 'handle', 'value']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_check',
    description: 'Set an approved checkbox or radio element checked state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        checked: { type: 'boolean' },
        ...POST_ACTION_SNAPSHOT_PROPERTIES
      },
      required: ['origin', 'handle', 'checked']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_scroll',
    description: 'Scroll the approved page after resolving a page element handle in the current page state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
        ...POST_ACTION_SNAPSHOT_PROPERTIES
      },
      required: ['origin', 'handle', 'deltaX', 'deltaY']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_press_key',
    description: 'Dispatch a key press to an approved page element handle.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        key: { type: 'string' },
        ...POST_ACTION_SNAPSHOT_PROPERTIES
      },
      required: ['origin', 'handle', 'key']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_click',
    description: 'Click an approved page element handle.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        ...POST_ACTION_SNAPSHOT_PROPERTIES
      },
      required: ['origin', 'handle']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_approvals_list',
    description: 'List pending or historical browser operator approval requests.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string' }
      },
      required: []
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_approval_approve',
    description: 'Approve a pending browser operator approval request after an explicit user decision.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        approvalId: { type: 'string' },
        userDecision: { type: 'string' }
      },
      required: ['approvalId', 'userDecision']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_approval_reject',
    description: 'Reject a pending browser operator approval request after an explicit user decision.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        approvalId: { type: 'string' },
        userDecision: { type: 'string' }
      },
      required: ['approvalId', 'userDecision']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_approval_run',
    description: 'Run a previously approved browser operator approval request.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        approvalId: { type: 'string' }
      },
      required: ['approvalId']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_emergency_stop',
    description: 'Activate the browser operator emergency stop.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string' }
      },
      required: []
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_emergency_clear',
    description: 'Clear the browser operator emergency stop.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: []
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  }
];

module.exports = {
  ADAPTER_PROTOCOL_VERSION,
  TOOL_DEFINITIONS,
  TOOL_SCHEMA_VERSION
};
