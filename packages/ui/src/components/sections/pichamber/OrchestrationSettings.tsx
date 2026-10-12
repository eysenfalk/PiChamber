import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { NumberInput } from '@/components/ui/number-input';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsControlGroup,
  SETTINGS_SELECT_SIZE,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_NUMBER_UNIT_CLASS,
  SETTINGS_CONTROL_CLUSTER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsModelPicker } from '@/components/sections/shared/SettingsModelPicker';
import { piClient } from '@/lib/pi/client';
import {
  catalogThinkingLevels,
  modelHasConfigurableThinking,
  PI_THINKING_LEVEL_LABELS,
} from '@/lib/pi/thinking';
import { reportSettingsSaveState } from '@/lib/persistence';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type {
  PiChamberDefaultsUpdateInput,
  PiOrchestrationRole,
  PiOrchestrationRoleModel,
  PiSettingsSnapshot,
} from '@/lib/pi/protocol';
import type { PiThinkingLevel } from '@/lib/pi/types';
import { useConfigStore } from '@/stores/useConfigStore';

const providerScope = () => ({ runtimeKey: getRuntimeKey() });

const MIN_WORKERS = 1;
const MAX_WORKERS = 16;
const ALL_THINKING_LEVELS = Object.keys(PI_THINKING_LEVEL_LABELS) as PiThinkingLevel[];

const ROLES: ReadonlyArray<{ role: PiOrchestrationRole; label: string; info: string }> = [
  { role: 'implementation', label: "Implementation", info: "Workers that change code." },
  { role: 'research', label: "Research", info: "Workers that read code, documentation or the web and report back." },
  { role: 'small', label: "Small tasks", info: "Short, narrow tasks where a cheap model is enough." },
  { role: 'review', label: "Review", info: "Workers that review the changes of another worker." },
];

type Snapshot = Pick<PiSettingsSnapshot, 'pichamber' | 'orchestration'>;

/** Worker limit and role models for sessions that start worker sessions through the `pichamber` tools. */
export const OrchestrationSettings: React.FC = () => {
  const providers = useConfigStore((state) => state.providers);
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'failed'>('loading');

  React.useEffect(() => {
    let active = true;
    piClient.getSettings(providerScope()).then((next) => {
      if (!active) return;
      setSnapshot({ pichamber: next.pichamber, orchestration: next.orchestration });
      setLoadState('ready');
    }).catch(() => {
      if (active) setLoadState('failed');
    });
    return () => { active = false; };
  }, []);

  const persist = React.useCallback(async (orchestration: NonNullable<PiChamberDefaultsUpdateInput['orchestration']>) => {
    reportSettingsSaveState('saving');
    try {
      setSnapshot(await piClient.setPiChamberDefaults({ orchestration }, providerScope()));
      reportSettingsSaveState('saved');
    } catch {
      reportSettingsSaveState('error');
    }
  }, []);

  const findModel = React.useCallback((role: PiOrchestrationRoleModel) => {
    for (const provider of providers) {
      if (role.providerId && provider.id !== role.providerId) continue;
      const models = Array.isArray(provider.models) ? provider.models : [];
      const model = models.find((entry) => entry.id === role.modelId);
      if (model) return model;
    }
    return undefined;
  }, [providers]);

  if (loadState === 'loading') return null;

  if (!snapshot?.orchestration) {
    return (
      <SettingsSection title="Orchestration">
        <p className="typography-meta text-[var(--status-error)]">{"Orchestration settings are unavailable."}</p>
      </SettingsSection>
    );
  }

  const { orchestration } = snapshot;
  const stored = snapshot.pichamber.orchestration?.roles ?? {};

  return (
    <SettingsSection
      title="Orchestration"
      info="A session can start worker sessions with the pichamber tools. These settings choose the model for each worker role and how many unfinished workers one session tree may run."
    >
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <SettingsFieldRow
          settingsItem="sessions.orchestration-worker-limit"
          label="Worker limit"
          info="How many unfinished workers one orchestrating session and its workers may run at the same time. Further starts are refused until a worker finishes or is stopped."
        >
          <div className={SETTINGS_CONTROL_CLUSTER_CLASS}>
            <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
              <NumberInput
                value={orchestration.workerLimit}
                min={MIN_WORKERS}
                max={MAX_WORKERS}
                step={1}
                aria-label="Worker limit"
                onValueChange={(value) => {
                  if (!Number.isFinite(value)) return;
                  const clamped = Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Math.round(value)));
                  if (clamped !== orchestration.workerLimit) void persist({ workerLimit: clamped });
                }}
              />
              <span className={SETTINGS_NUMBER_UNIT_CLASS}>workers</span>
            </div>
          </div>
        </SettingsFieldRow>

        <SettingsControlGroup
          settingsItem="sessions.orchestration-roles"
          title="Worker roles"
          info="The model and thinking level a worker gets when the orchestrating session starts it with this role. Without a provider the model is looked up in the configured providers when the worker starts."
          contentClassName={SETTINGS_FIELDS_STACK_CLASS}
        >
          {ROLES.map(({ role, label, info }) => {
            const effective = orchestration.roles[role];
            const override = stored[role];
            const catalogModel = findModel(effective);
            const levels = catalogModel ? catalogThinkingLevels(catalogModel) : ALL_THINKING_LEVELS;
            const showThinking = !catalogModel || modelHasConfigurableThinking(levels);
            const options = effective.thinking && !levels.includes(effective.thinking)
              ? [...levels, effective.thinking]
              : levels;
            return (
              <SettingsFieldRow key={role} label={label} info={info}>
                <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex flex-wrap items-center gap-2`}>
                  <SettingsModelPicker
                    value={override?.providerId ? { providerId: override.providerId, modelId: override.modelId } : null}
                    noneLabel={override ? override.modelId : `${effective.modelId} (default)`}
                    ariaLabel={`${label} model`}
                    onChange={(model) => {
                      void persist({ roles: { [role]: model ? { ...model, ...(override?.thinking ? { thinking: override.thinking } : {}) } : null } });
                    }}
                  />
                  {showThinking ? (
                    <Select
                      value={effective.thinking ?? ''}
                      onValueChange={(value) => {
                        if (!value) return;
                        void persist({
                          roles: {
                            [role]: {
                              ...(effective.providerId ? { providerId: effective.providerId } : {}),
                              modelId: effective.modelId,
                              thinking: value as PiThinkingLevel,
                            },
                          },
                        });
                      }}
                    >
                      <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-32" aria-label={`${label} thinking`}>
                        <SelectValue>
                          {(value) => (value ? PI_THINKING_LEVEL_LABELS[value as PiThinkingLevel] ?? (value as string) : "Model default")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((level) => (
                          <SelectItem key={level} value={level}>{PI_THINKING_LEVEL_LABELS[level]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
              </SettingsFieldRow>
            );
          })}
        </SettingsControlGroup>
      </div>
    </SettingsSection>
  );
};
