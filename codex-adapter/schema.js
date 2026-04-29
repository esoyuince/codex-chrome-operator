'use strict';

const ADAPTER_PROTOCOL_VERSION = '1.0';
const TOOL_SCHEMA_VERSION = '2026-04-29.m1';

const TOOL_DEFINITIONS = [
  {
    name: 'codex_chrome_status',
    description: 'Return local Chrome operator daemon status.',
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
    name: 'codex_chrome_open_observe',
    description: 'Prepare an origin, open a URL in Chrome, wait for the tab, and return a DOM observation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', format: 'uri' },
        timeoutMs: { type: 'number', minimum: 0 },
        pollIntervalMs: { type: 'number', minimum: 1 }
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
    name: 'codex_chrome_visual_observe',
    description: 'Return a visual observation with screenshot artifact references, not raw image bytes.',
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
    name: 'codex_chrome_fill',
    description: 'Fill an approved page element handle.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        origin: { type: 'string' },
        handle: { type: 'string' },
        text: { type: 'string' }
      },
      required: ['origin', 'handle', 'text']
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
        handle: { type: 'string' }
      },
      required: ['origin', 'handle']
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
