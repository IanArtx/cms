// ============================================================
// useScrollHints (v1.77.0)
// Makes every sideways-scrolling tab row (.tab-bar) easy to use on a
// phone, on every page, without each page having to do anything:
//
//   • a soft fade appears on the side where more tabs are hidden
//     (classes more-left / more-right, styled in index.css), so it is
//     obvious the row can be swiped;
//   • the selected tab (.tab-active) is scrolled into view — e.g. when a
//     page opens straight on its 6th tab from a link — but only when the
//     selection changes, so it never fights the person's own swiping;
//   • any TABLE wider than the space it has, and not already inside
//     something that scrolls sideways, gets the class cms-table-scroll
//     (index.css) so it can be swiped instead of being cut off at the
//     screen edge. Taken off again when it fits (e.g. phone turned).
//
// Mounted once in AppLayout. Watches the page for tab rows appearing or
// changing (a MutationObserver), batched to one update per frame.
// ============================================================

import { useEffect } from 'react';

const updateHints = (bar) => {
    const max = bar.scrollWidth - bar.clientWidth;
    const left = bar.scrollLeft;
    bar.classList.toggle('more-left', max > 2 && left > 2);
    bar.classList.toggle('more-right', max > 2 && left < max - 2);
};

const bringActiveIntoView = (bar) => {
    const active = bar.querySelector('.tab-active');
    if (!active || bar.__cmsLastActive === active) return;
    bar.__cmsLastActive = active;
    const barBox = bar.getBoundingClientRect();
    const tabBox = active.getBoundingClientRect();
    const hiddenLeft = tabBox.left < barBox.left;
    const hiddenRight = tabBox.right > barBox.right;
    if (!hiddenLeft && !hiddenRight) return;
    // Centre the tab in the row — horizontal only (scrollIntoView would
    // also jump the page up or down).
    const target = bar.scrollLeft + (tabBox.left - barBox.left) - (barBox.width - tabBox.width) / 2;
    bar.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
};

// Is `el` inside an element that already scrolls sideways?
const insideSideScroller = (el, root) => {
    let x = el.parentElement;
    while (x && x !== root) {
        const ox = window.getComputedStyle(x).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
        x = x.parentElement;
    }
    return false;
};

const fitTable = (table, root) => {
    const has = table.classList.contains('cms-table-scroll');
    if (!has && insideSideScroller(table, root)) return;
    const parent = table.parentElement;
    if (!parent) return;
    const room = parent.clientWidth;
    const needs = table.scrollWidth > room + 1;
    if (needs !== has) table.classList.toggle('cms-table-scroll', needs);
};

const setUp = (bar) => {
    if (!bar.__cmsHints) {
        bar.__cmsHints = true;
        bar.addEventListener('scroll', () => updateHints(bar), { passive: true });
    }
    bringActiveIntoView(bar);
    updateHints(bar);
};

const useScrollHints = (rootId = 'main-content') => {
    useEffect(() => {
        const root = document.getElementById(rootId) || document.body;
        let frame = null;
        const scan = () => {
            frame = null;
            root.querySelectorAll('.tab-bar').forEach(setUp);
            root.querySelectorAll('table').forEach(t => fitTable(t, root));
        };
        const schedule = () => { if (frame === null) frame = window.requestAnimationFrame(scan); };

        schedule();
        const observer = new MutationObserver(schedule);
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        window.addEventListener('resize', schedule);
        return () => {
            observer.disconnect();
            window.removeEventListener('resize', schedule);
            if (frame !== null) window.cancelAnimationFrame(frame);
        };
    }, [rootId]);
};

export default useScrollHints;
