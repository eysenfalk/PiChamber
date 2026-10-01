import React from 'react';

import {
  SETTINGS_OPTION_STACK_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
  SettingsTwoColumn,
} from '@/components/sections/shared/SettingsSection';
import type { FollowUpBehavior } from '@/stores/messageQueueStore';
import {
  DIFF_LAYOUT_OPTIONS,
  FOLLOW_UP_BEHAVIOR_OPTIONS,
  type VisibleSetting,
} from './visualSettingsConstants';

export interface ChatBehaviorSectionProps {
  hasBehaviorSettings: boolean;
  showBehaviorMessageOptions: boolean;
  behaviorSectionDivider: boolean;
  shouldShow: (setting: VisibleSetting) => boolean;
  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  setDiffLayoutPreference: (layout: 'dynamic' | 'inline' | 'side-by-side') => void;
  followUpBehavior: FollowUpBehavior;
  setFollowUpBehavior: (behavior: FollowUpBehavior) => void;
  draftStartersVisible: boolean;
  onDraftStartersVisibleChange: (visible: boolean) => void;
  expandToolCallsByDefault: boolean;
  onExpandToolCallsByDefaultChange: (expanded: boolean) => void;
}

export const ChatBehaviorSection: React.FC<ChatBehaviorSectionProps> = ({
  hasBehaviorSettings,
  showBehaviorMessageOptions,
  behaviorSectionDivider,
  shouldShow,
  diffLayoutPreference,
  setDiffLayoutPreference,
  followUpBehavior,
  setFollowUpBehavior,
  draftStartersVisible,
  onDraftStartersVisibleChange,
  expandToolCallsByDefault,
  onExpandToolCallsByDefaultChange,
}) => {
  if (!hasBehaviorSettings) return null;

  return (
    <>
      {showBehaviorMessageOptions && (
        <SettingsSection title={'Message options'} divider={behaviorSectionDivider}>
          {/* Flat 2×2 grid so row headers share a baseline (not stacked columns). */}
          <SettingsTwoColumn className="lg:gap-y-6">
            {shouldShow('diffLayout') && (
              <SettingsControlGroup title={'Diff Layout'}>
                <SettingsRadioGroup aria-label={'Diff layout'}>
                  {DIFF_LAYOUT_OPTIONS.map((option) => (
                    <SettingsRadioOption
                      key={option.id}
                      selected={diffLayoutPreference === option.id}
                      onSelect={() => setDiffLayoutPreference(option.id)}
                      label={option.label}
                      ariaLabel={`Diff layout: ${option.label}`}
                    />
                  ))}
                </SettingsRadioGroup>
              </SettingsControlGroup>
            )}

            {shouldShow('followUpBehavior') && (
              <SettingsControlGroup
                title={'Follow-up behavior'}
                info={'Follow-up waits until the agent finishes, then sends. Steering is delivered at the next supported tool or turn boundary. Follow-ups stay on this device.'}
                settingsItem="chat.follow-up-behavior"
              >
                <SettingsRadioGroup aria-label={'Follow-up behavior'}>
                  {FOLLOW_UP_BEHAVIOR_OPTIONS.map((option) => (
                    <SettingsRadioOption
                      key={option.id}
                      selected={followUpBehavior === option.id}
                      onSelect={() => setFollowUpBehavior(option.id)}
                      label={option.label}
                      ariaLabel={`Follow-up behavior: ${option.label}`}
                    />
                  ))}
                </SettingsRadioGroup>
              </SettingsControlGroup>
            )}
          </SettingsTwoColumn>
        </SettingsSection>
      )}

      <SettingsSection
        title={'Features'}
        contentClassName={SETTINGS_OPTION_STACK_CLASS}
      >
        <SettingsCheckboxRow
          checked={draftStartersVisible}
          onChange={onDraftStartersVisibleChange}
          label={'Show Starters on New Session Screen'}
          ariaLabel={'Show starters on the new session screen'}
          settingsItem="chat.draft-starters-visible"
        />
        <SettingsCheckboxRow
          checked={expandToolCallsByDefault}
          onChange={onExpandToolCallsByDefaultChange}
          label={'Expand Tool Calls by Default'}
          ariaLabel={'Expand tool calls by default'}
          info={'Opens every tool call, including the calls inside Fabric runs, and keeps the activity list open after the answer. You can still toggle all tool calls for the current window with the Toggle tool calls shortcut or the session menu.'}
          settingsItem="chat.expand-tool-calls"
        />
      </SettingsSection>
    </>
  );
};
