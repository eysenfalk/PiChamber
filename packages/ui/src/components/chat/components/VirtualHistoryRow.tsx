import React from 'react';

type VirtualHistoryRowProps = {
    index: number;
    entryKey: string;
    measureElement: (node: HTMLDivElement | null) => void;
    children: React.ReactNode;
};

/**
 * One measured row of the virtualized history.
 *
 * `flow-root` makes the row its own block formatting context. The virtualizer
 * measures the row's border box, so a bottom margin collapsing out of a child
 * (the user message's time row) would add layout height that is never counted.
 * The list container has the summed measured height, the rows overflow it, and
 * the live tail below is drawn over the last history rows.
 */
export const VirtualHistoryRow: React.FC<VirtualHistoryRowProps> = ({ index, entryKey, measureElement, children }) => (
    <div
        data-index={index}
        ref={measureElement}
        data-turn-entry={entryKey}
        className="flow-root"
    >
        {children}
    </div>
);
