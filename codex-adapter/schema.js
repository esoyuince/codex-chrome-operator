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
  includeAx: { type: 'boolean' },
  includeFormValues: { type: 'boolean' },
  maxFieldValueChars: { type: 'number', minimum: 0 }
};

const BATCH_OBSERVE_OPTION_PROPERTIES = {
  mode: OBSERVE_OPTION_PROPERTIES.mode,
  maxActionableHandles: OBSERVE_OPTION_PROPERTIES.maxActionableHandles,
  summaryMaxChars: OBSERVE_OPTION_PROPERTIES.summaryMaxChars,
  sincePageStateId: OBSERVE_OPTION_PROPERTIES.sincePageStateId,
  includeAx: OBSERVE_OPTION_PROPERTIES.includeAx,
  includeFormValues: OBSERVE_OPTION_PROPERTIES.includeFormValues,
  maxFieldValueChars: OBSERVE_OPTION_PROPERTIES.maxFieldValueChars
};

const TARGET_CONTRACT_BOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
    width: { type: 'number', minimum: 1 },
    height: { type: 'number', minimum: 1 }
  }
};

const TARGET_CONTRACT_CONTEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string' },
    viewport: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'number', minimum: 1 },
        height: { type: 'number', minimum: 1 }
      }
    },
    scroll: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'number' },
        y: { type: 'number' }
      }
    },
    devicePixelRatio: { type: 'number', minimum: 0 }
  }
};

const TARGET_CONTRACT_DATA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    testid: { type: 'string' },
    testId: { type: 'string' },
    testID: { type: 'string' },
    test: { type: 'string' },
    risk: { type: 'string' },
    productId: { type: 'string' },
    visualCard: { type: 'string' },
    uploadRole: { type: 'string' },
    previewRole: { type: 'string' },
    validationMessage: { type: 'string' },
    analyzerField: { type: 'string' },
    cartAction: { type: 'string' },
    sensitivePage: { type: 'string' },
    visualPolicy: { type: 'string' },
    analysisPolicy: { type: 'string' },
    rating: { type: 'string' }
  }
};

const TARGET_CONTRACT_PROVENANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    shadowDepth: { type: 'number', minimum: 0 },
    frameDepth: { type: 'number', minimum: 0 },
    frameTitle: { type: 'string' },
    frameName: { type: 'string' },
    frameSrc: { type: 'string' }
  }
};

const TARGET_CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'number' },
    handle: { type: 'string' },
    tag: { type: 'string' },
    role: { type: 'string' },
    type: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    href: { type: 'string' },
    placeholder: { type: 'string' },
    title: { type: 'string' },
    label: { type: 'string' },
    accessibleName: { type: 'string' },
    testid: { type: 'string' },
    data: TARGET_CONTRACT_DATA_SCHEMA,
    productId: { type: 'string' },
    bbox: TARGET_CONTRACT_BOX_SCHEMA,
    context: TARGET_CONTRACT_CONTEXT_SCHEMA,
    provenance: TARGET_CONTRACT_PROVENANCE_SCHEMA
  }
};

const POST_ACTION_SNAPSHOT_PROPERTIES = {
  postActionSnapshot: {
    type: 'string',
    enum: ['delta']
  },
  sincePageStateId: { type: 'string' },
  mode: OBSERVE_OPTION_PROPERTIES.mode,
  maxActionableHandles: OBSERVE_OPTION_PROPERTIES.maxActionableHandles,
  summaryMaxChars: OBSERVE_OPTION_PROPERTIES.summaryMaxChars,
  requireVerified: { type: 'boolean' },
  postActionVerifyDelayMs: { type: 'number', minimum: 0 },
  actionTrace: { type: 'boolean' },
  actionTraceLabel: { type: 'string' },
  actionTraceDurationMs: { type: 'number', minimum: 100 },
  targetContract: TARGET_CONTRACT_SCHEMA,
  verify: {
    type: 'object',
    additionalProperties: false,
    properties: {
      oneOf: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: {
              type: 'string',
              enum: ['textAppears', 'textAppearsInArticle', 'elementGone', 'elementEnabled', 'valueEquals']
            },
            text: { type: 'string' },
            handle: { type: 'string' },
            value: { type: 'string' }
          },
          required: ['type']
        }
      }
    },
    required: ['oneOf']
  }
};

const FORM_FIELD_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    handle: { type: 'string' },
    text: { type: 'string' },
    value: { type: 'string' }
  },
  required: ['handle']
};

const FORM_STEP_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['fill'] },
    handle: { type: 'string' },
    text: { type: 'string' },
    value: { type: 'string' }
  },
  required: ['action', 'handle']
};

const SESSION_TAB_KEEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tabId: { type: 'number', minimum: 0 },
    status: { type: 'string', enum: ['handoff', 'deliverable'] }
  },
  required: ['tabId', 'status']
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
    postActionSnapshot: POST_ACTION_SNAPSHOT_PROPERTIES.postActionSnapshot,
    actionTrace: POST_ACTION_SNAPSHOT_PROPERTIES.actionTrace,
    actionTraceLabel: POST_ACTION_SNAPSHOT_PROPERTIES.actionTraceLabel,
    actionTraceDurationMs: POST_ACTION_SNAPSHOT_PROPERTIES.actionTraceDurationMs,
    targetContract: POST_ACTION_SNAPSHOT_PROPERTIES.targetContract,
    verify: POST_ACTION_SNAPSHOT_PROPERTIES.verify
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
    name: 'codex_chrome_user_tabs',
    description: 'List claimable user Chrome tabs without taking control of them.',
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
  },
  {
    name: 'codex_chrome_recent_tabs',
    description: 'List enriched recent Chrome tabs without taking control of them.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', minimum: 1 }
      },
      required: []
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_history_search',
    description: 'Search local Chrome history for context when the user asks to use real browser state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number', minimum: 1 }
      },
      required: ['query']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_bookmark_search',
    description: 'Search local Chrome bookmarks for user-selected browser context.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number', minimum: 1 }
      },
      required: ['query']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_reopen_closed_tab',
    description: 'Restore the most recent closed Chrome tab or a provided session id, optionally claiming it into the operator session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string' },
        claim: { type: 'boolean' }
      },
      required: []
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_download_wait',
    description: 'Wait for a Chrome download matching filename, URL, or state and return compact download evidence.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filenameContains: { type: 'string' },
        urlContains: { type: 'string' },
        state: { type: 'string', enum: ['complete', 'in_progress', 'interrupted'] },
        timeoutMs: { type: 'number', minimum: 0 },
        pollIntervalMs: { type: 'number', minimum: 50 }
      },
      required: []
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_download_show',
    description: 'Show a Chrome download item in the browser download shelf or file manager when Chrome supports it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        downloadId: { type: 'number', minimum: 0 }
      },
      required: ['downloadId']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_claim_tab',
    description: 'Claim a Chrome tab from the latest user tab inventory into this operator session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 }
      },
      required: ['tabId']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_session_tabs',
    description: 'List tabs owned by this operator session.',
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
  },
  {
    name: 'codex_chrome_tab_focus',
    description: 'Focus the Chrome window for a tab and make that tab active.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 }
      },
      required: ['tabId']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_pin',
    description: 'Pin or unpin a Chrome tab.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 },
        pinned: { type: 'boolean' }
      },
      required: ['tabId', 'pinned']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_move',
    description: 'Move a Chrome tab to a new index and optionally another window.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 },
        index: { type: 'number', minimum: 0 },
        windowId: { type: 'number', minimum: 0 }
      },
      required: ['tabId', 'index']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_group_rename',
    description: 'Rename an existing Chrome tab group.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        groupId: { type: 'number', minimum: 0 },
        title: { type: 'string' }
      },
      required: ['groupId', 'title']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_new_tab',
    description: 'Create a new Chrome tab owned by this operator session.',
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
  },
  {
    name: 'codex_chrome_name_session',
    description: 'Name the current operator browser session for tab grouping and status.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string' }
      },
      required: ['name']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_finalize_tabs',
    description: 'Finalize operator-owned tabs, keeping selected tabs as handoff or deliverable and releasing or closing the rest.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keep: {
          type: 'array',
          items: SESSION_TAB_KEEP_SCHEMA
        }
      },
      required: ['keep']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_policy_status',
    description: 'Read operator policy toggles for guarded actions and purchase approvals.',
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
  },
  {
    name: 'codex_chrome_policy_update',
    description: 'Update operator policy toggles for guarded actions and purchase approvals.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        guardedActionsEnabled: { type: 'boolean' },
        purchaseApprovalsEnabled: { type: 'boolean' }
      },
      required: []
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_screenshot',
    description: 'Capture an artifact-backed screenshot of a session-owned Chrome tab through the guarded CDP path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
        quality: { type: 'number', minimum: 1 }
      },
      required: ['tabId']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_handle_dialog',
    description: 'Accept or dismiss a native JavaScript/browser dialog such as beforeunload on a session-owned Chrome tab.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 },
        accept: { type: 'boolean' },
        promptText: { type: 'string' }
      },
      required: ['tabId', 'accept']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_goto',
    description: 'Navigate a session-owned Chrome tab to an approved URL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 },
        url: { type: 'string', format: 'uri' }
      },
      required: ['tabId', 'url']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_observe',
    description: 'Observe a session-owned Chrome tab without relying on the active tab.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 },
        ...OBSERVE_OPTION_PROPERTIES
      },
      required: ['tabId']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_read_page',
    description: 'Read compact page text from a session-owned Chrome tab without relying on the active tab.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 },
        filter: READ_PAGE_PROPERTIES.filter,
        depth: READ_PAGE_PROPERTIES.depth,
        maxChars: READ_PAGE_PROPERTIES.maxChars,
        refId: READ_PAGE_PROPERTIES.refId,
        includeFormValues: READ_PAGE_PROPERTIES.includeFormValues,
        maxFieldValueChars: READ_PAGE_PROPERTIES.maxFieldValueChars
      },
      required: ['tabId']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_locator',
    description: 'Resolve or run a narrow guarded action against one visible actionable element in a session-owned tab. Fails closed on zero or multiple matches.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 },
        selector: { type: 'string' },
        text: { type: 'string' },
        action: {
          type: 'string',
          enum: ['resolve', 'click', 'type', 'fill', 'focus', 'clear']
        },
        textValue: { type: 'string' },
        includeFormValues: OBSERVE_OPTION_PROPERTIES.includeFormValues,
        maxFieldValueChars: OBSERVE_OPTION_PROPERTIES.maxFieldValueChars,
        ...POST_ACTION_SNAPSHOT_PROPERTIES
      },
      required: ['tabId']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_show_target',
    description: 'Show a temporary visual cue around a target in a session-owned tab before acting.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 },
        handle: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        durationMs: { type: 'number', minimum: 100 }
      },
      required: ['tabId']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_tab_operator_indicator',
    description: 'Show or hide the in-page operator active indicator for a session-owned tab.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'number', minimum: 0 },
        active: { type: 'boolean' },
        label: { type: 'string' },
        stopReason: { type: 'string' }
      },
      required: ['tabId']
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
    name: 'codex_chrome_media_inspect',
    description: 'Inspect visible video and audio elements on an approved active tab without returning raw media bytes.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        maxItems: { type: 'number', minimum: 1 }
      },
      required: ['origin']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_visual_inspect_target',
    description: 'Capture visual evidence for a specific observed target handle and return screenshot-backed region artifact references.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        maxBytes: { type: 'number', minimum: 1 },
        reason: { type: 'string' }
      },
      required: ['origin', 'handle']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_form_extract',
    description: 'Extract form fields, labels, validation state, and submit targets without leaking sensitive values.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        includeValues: { type: 'boolean' }
      },
      required: ['origin']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_form_fill_plan',
    description: 'Create a bounded form fill plan for explicit field handles; submit actions remain out of scope.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        fields: {
          type: 'array',
          minItems: 1,
          items: FORM_FIELD_INPUT_SCHEMA
        }
      },
      required: ['origin', 'fields']
    },
    outputContract: {
      untrusted: true,
      rawScreenshotBytes: false
    }
  },
  {
    name: 'codex_chrome_form_fill_execute',
    description: 'Execute a bounded non-submit form fill plan and return validation state.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        steps: {
          type: 'array',
          minItems: 1,
          items: FORM_STEP_INPUT_SCHEMA
        }
      },
      required: ['origin', 'steps']
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
