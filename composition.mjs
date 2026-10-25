// GENERATED FILE - do not edit by hand. Regenerate with:
//   DSH_SOURCE=<compatible DSH checkout> node build-composition.mjs
// Source: DSH 0.2.1-rc.3 packages/bundle/web-app/presets/standard.patch.yml
// A programmatic Agent Preset definition receives evaluated entry options, so the
// Loader's YAML platform conditions appear here as live booleans. The drift gate in
// tests/composition-drift.mjs compares these rows with the host declaration for the
// running DSH checkout (CI covers every verified release tag).
const WINDOWS = process.platform === 'win32'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

/** DSH Standard preset child rows; a preset replaces the agent composition, so Thaliris must carry them. */
export const STANDARD_COMPOSITION = deepFreeze([
  {
    "id": "persona",
    "name": "@deepseek-ai/dsh-persona",
    "config": {
      "prefix": "You are a coding agent powered by the {{model}} model."
    }
  },
  {
    "id": "agent-instructions",
    "name": "@deepseek-ai/dsh-agent-instructions",
    "config": {
      "maxBytes": 65536
    }
  },
  {
    "id": "time-context",
    "name": "@deepseek-ai/dsh-time-context"
  },
  {
    "id": "tool-bash",
    "name": "@deepseek-ai/dsh-tool-bash",
    "disabled": WINDOWS
  },
  {
    "id": "tool-pwsh",
    "name": "@deepseek-ai/dsh-tool-pwsh",
    "disabled": !WINDOWS
  },
  {
    "id": "tool-fs",
    "name": "@deepseek-ai/dsh-tool-fs"
  },
  {
    "id": "tool-fs-search",
    "name": "@deepseek-ai/dsh-tool-fs-search",
    "config": {
      "sampleOverCapGlobResults": false
    }
  },
  {
    "id": "tool-jobs",
    "name": "@deepseek-ai/dsh-tool-jobs"
  },
  {
    "id": "tool-schedule",
    "name": "@deepseek-ai/dsh-tool-schedule"
  },
  {
    "id": "skill-filesystem",
    "name": "@deepseek-ai/dsh-skill-filesystem"
  },
  {
    "id": "tool-skill",
    "name": "@deepseek-ai/dsh-tool-skill"
  },
  {
    "id": "command-goal",
    "name": "@deepseek-ai/dsh-command-goal"
  },
  {
    "id": "tool-goal",
    "name": "@deepseek-ai/dsh-tool-goal"
  },
  {
    "id": "planning",
    "name": "cordis:group",
    "group": true,
    "isolate": {
      "planMode": true
    },
    "config": [
      {
        "id": "plan-mode",
        "name": "@deepseek-ai/dsh-plan-mode",
        "config": {
          "section": "You are in plan mode. Stay in plan mode until the user approves your plan through exit_plan_mode or switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.\n\nExplore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.\n\nThe tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.\n\nResolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.\n\nMake the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.\n\nWhen ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask \"should I proceed?\" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.\n"
        }
      }
    ]
  },
  {
    "id": "compaction",
    "name": "cordis:group",
    "group": true,
    "isolate": {
      "compaction": true,
      "toolResultPruner": true
    },
    "config": [
      {
        "id": "compaction-basic",
        "name": "@deepseek-ai/dsh-compaction-basic"
      },
      {
        "id": "command-compact",
        "name": "@deepseek-ai/dsh-command-compact"
      },
      {
        "id": "tool-result-pruner",
        "name": "@deepseek-ai/dsh-compaction-tool-result-pruner",
        "config": {
          "thresholdChars": 8192,
          "headChars": 4096,
          "tailChars": 1024
        }
      }
    ]
  },
  {
    "id": "delegation",
    "name": "cordis:group",
    "group": true,
    "isolate": {
      "workflowEngine": true
    },
    "config": [
      {
        "id": "tool-subagent-control",
        "name": "@deepseek-ai/dsh-tool-subagent-control"
      },
      {
        "id": "tool-subagent-list-agents",
        "name": "@deepseek-ai/dsh-tool-subagent-control/list-agents"
      },
      {
        "id": "tool-subagent",
        "name": "@deepseek-ai/dsh-tool-subagent",
        "config": {
          "provider": "spawn",
          "toolName": "subagent",
          "modelSelectionSettings": true
        }
      },
      {
        "id": "tool-subagent-fork",
        "name": "@deepseek-ai/dsh-tool-subagent",
        "config": {
          "provider": "fork",
          "toolName": "subagent_fork"
        }
      },
      {
        "id": "workflow-ptc",
        "name": "@deepseek-ai/dsh-workflow-ptc",
        "config": {
          "provider": "spawn"
        }
      },
      {
        "id": "tool-workflow",
        "name": "@deepseek-ai/dsh-tool-workflow"
      }
    ]
  },
  {
    "id": "tool-ask-user",
    "name": "@deepseek-ai/dsh-tool-ask-user"
  },
  {
    "id": "tool-todo",
    "name": "@deepseek-ai/dsh-tool-todo",
    "config": {
      "allowParallelInProgress": true
    }
  },
  {
    "id": "tool-web",
    "name": "@deepseek-ai/dsh-tool-web",
    "config": {
      "fetch": true,
      "searchTimeoutMs": 60000
    }
  },
  {
    "id": "present",
    "name": "@deepseek-ai/dsh-tool-present"
  },
  {
    "id": "tool-plugin-manager",
    "name": "@deepseek-ai/dsh-plugin-manager/tools",
    "disabled": true
  },
  {
    "id": "tool-plugin-market",
    "name": "@deepseek-ai/dsh-plugin-market/tools",
    "disabled": true
  }
])

/** Appended row: the Thaliris preset-scoped module that owns the model-visible surface. */
export const THALIRIS_AGENT_ROW = deepFreeze({ id: 'thaliris-agent', name: '@thaliris/dsh-plugin/preset' })

/** Stable preset id; session logs and the native default-mode setting record it. */
export const THALIRIS_PRESET_ID = 'thaliris'
/** Roster display name; custom names are not localized by the host. */
export const THALIRIS_PRESET_NAME = 'Thaliris'
/** Roster description shown in the native mode picker. */
export const THALIRIS_PRESET_DESCRIPTION = 'Opt-in Thaliris Controller mode: Core task authority, bounded Workstreams, evidence continuity. Carries the standard DSH tools plus the Thaliris Controller surface.'
/** Display order after the four built-in presets (standard 1, ptc 2, minimal 3, cordis 4). */
export const THALIRIS_PRESET_ORDER = 10

/** Detached definition for `agentPresets.register`; the registry clones it on mount. */
export function thalirisPresetDefinition() {
  return { id: THALIRIS_PRESET_ID, name: THALIRIS_PRESET_NAME, description: THALIRIS_PRESET_DESCRIPTION, order: THALIRIS_PRESET_ORDER, plugins: [...STANDARD_COMPOSITION, THALIRIS_AGENT_ROW] }
}
