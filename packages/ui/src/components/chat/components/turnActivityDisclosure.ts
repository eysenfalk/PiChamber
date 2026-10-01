interface TurnActivityDisclosureInput {
    isExpanded: boolean;
    userToggled: boolean;
    wasAutoCollapsed: boolean;
    hasActivity: boolean;
    showWorkingStatus: boolean;
    hasFinalText: boolean;
    previousHadFinalText: boolean;
    hasNewActivity: boolean;
    /** "Expand tool calls" is on: the list stays open instead of closing after the answer. */
    keepOpen?: boolean;
}

interface TurnActivityDisclosureResult {
    isExpanded: boolean;
    wasAutoCollapsed: boolean;
    resetUserToggle: boolean;
}

export const resolveTurnActivityDisclosure = ({
    isExpanded,
    userToggled,
    wasAutoCollapsed,
    hasActivity,
    showWorkingStatus,
    hasFinalText,
    previousHadFinalText,
    hasNewActivity,
    keepOpen = false,
}: TurnActivityDisclosureInput): TurnActivityDisclosureResult => {
    if (!hasActivity) {
        return { isExpanded, wasAutoCollapsed, resetUserToggle: false };
    }

    if (keepOpen) {
        // A manual choice still wins; otherwise nothing closes the list.
        return userToggled
            ? { isExpanded, wasAutoCollapsed, resetUserToggle: false }
            : { isExpanded: true, wasAutoCollapsed: false, resetUserToggle: false };
    }

    const finalOutputStarted = showWorkingStatus && hasFinalText && !previousHadFinalText;
    if (finalOutputStarted) {
        return {
            isExpanded: false,
            wasAutoCollapsed: true,
            resetUserToggle: userToggled,
        };
    }

    if (userToggled) {
        return { isExpanded, wasAutoCollapsed, resetUserToggle: false };
    }

    if (hasNewActivity && wasAutoCollapsed) {
        return { isExpanded: true, wasAutoCollapsed: false, resetUserToggle: false };
    }

    if (showWorkingStatus && !hasFinalText && !isExpanded) {
        return { isExpanded: true, wasAutoCollapsed, resetUserToggle: false };
    }

    if (showWorkingStatus && hasFinalText && isExpanded) {
        return { isExpanded: false, wasAutoCollapsed: true, resetUserToggle: false };
    }

    return { isExpanded, wasAutoCollapsed, resetUserToggle: false };
};
