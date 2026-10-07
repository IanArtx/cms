// ============================================================
// GUIDED TOUR (v1.82.0)
//
// Requested: "the system needs a guided tour functionality that shows
// the users how to navigate through the system explaining the
// functionality of the features".
// Confirmed:
//   • the main tour (the screen: menu groups, shortcuts, top bar, + New,
//     search, notifications, profile menu, phone bottom bar) starts by
//     itself the first time a person signs in, and is remembered in their
//     account so it does not start again on another phone or computer;
//   • it can be taken again at any time — profile menu › Take the guided
//     tour, the (?) button, or About;
//   • every main page has a short "Tour this page" (its tabs, buttons
//     and steps), written in guide/manualModules.js;
//   • the tour shows only what the person can open (their role).
//
// How it works: each step points at one part of the screen — found by
// its data-tour="…" mark, a tab's label, a button's label or the page
// header — dims everything else and explains it in a small card. A step
// whose part is not on the screen (the person's role does not have it)
// is skipped. Nothing on the page can be clicked while the tour is open,
// so the tour can never change anything.
//
//   const { startMainTour, startPageTour, pageTour } = useTour();
// ============================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import { useLayout } from '../layout/LayoutContext';
import { NAV_GROUPS } from '../layout/navConfig';
import { usersAPI } from '../../api/endpoints';
import { pageTourFor } from '../../guide/manualContent';
import TourOverlay from './TourOverlay';

const TourContext = createContext(null);

const GROUP_HELP = {
    money: 'the company\'s accounts and every movement of money — recording, transfers, requests and approvals',
    members: 'what members hold and owe: savings, side fund, deposits, fines, shares, dividends and capital goals',
    investments: 'what the company has invested, borrowed or lent, and grants it receives',
    compliance: 'tax, reports, the books and audits',
    office: 'events, meetings and resolutions, documents, service fees, members, settings and this manual',
};

const isPhone = () => typeof window !== 'undefined' && window.innerWidth < 768;
const list = (labels) => (labels.length <= 1 ? labels.join('')
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`);

export const TourProvider = ({ children }) => {
    const { user, patchUser } = useAuth();
    const { branding } = useBranding();
    const { visibleItems, quickActions, isAuditor, setMobileOpen } = useLayout();
    const location = useLocation();
    const navigate = useNavigate();

    const [tour, setTour] = useState(null); // { id, title, steps, auto }
    const tourRef = useRef(null);
    tourRef.current = tour;
    const autoTried = useRef(false);

    // ---- the main tour, built for this person and this screen ---------
    const buildMainTour = useCallback(() => {
        const company = branding?.company_name || 'the company';
        const first = user?.first_name ? `, ${user.first_name}` : '';
        const phone = isPhone();
        const groups = NAV_GROUPS
            .map(g => ({ ...g, items: visibleItems.filter(i => i.group === g.id) }))
            .filter(g => g.items.length > 0);
        const steps = [];

        steps.push({
            title: `Welcome${first}!`,
            text: `This short tour shows you around ${company}'s system: where everything is and what each part does. It takes about a minute. You can leave at any time and take it again later from your picture (top right) › Take the guided tour, or from About.`,
        });

        if (isAuditor) {
            steps.push({ target: 'title', title: 'Your audit page', text: 'As an auditor you work on this one page: the accounts and documents shared with your engagement, your comments, your report files and the Finish Audit button.' });
            steps.push({ tourId: 'bell', title: 'Notifications', text: 'Updates on your submission and requests for more time appear here.' });
            steps.push({ tourId: 'profile', title: 'Your account', text: 'Unfinished forms, appearance (light or dark) and Sign out.' });
            steps.push({ title: 'That is all', text: 'The manual is not part of the auditor\'s page; the company\'s contact will help with anything else.' });
            return { id: 'main', title: 'Guided tour', steps };
        }

        if (phone) {
            steps.push({ tourId: 'bottom-bar', title: 'The bottom bar', text: 'On a phone, the most used things are at the bottom, within reach of your thumb.' });
            steps.push({ tourId: 'm-home', title: 'Home', text: 'Back to your Dashboard from anywhere.' });
            steps.push({ tourId: 'm-shortcuts', title: 'Shortcuts', text: 'Your pinned pages. To change them: Menu › Edit beside SHORTCUTS › tap ★ beside a page.' });
            if (quickActions.length) steps.push({ tourId: 'm-new', title: 'Create something new', text: `The quick forms you are allowed to use: ${list(quickActions.map(a => a.label.toLowerCase()))}.` });
            steps.push({ tourId: 'm-alerts', title: 'Alerts', text: 'Notifications: things waiting for you, approvals and events coming up.' });
            steps.push({ tourId: 'm-menu', title: 'Menu', text: 'Opens the full menu with every page you can use. Let\'s look inside.' });
            steps.push({ tourId: 'menu', drawer: true, title: 'The menu', text: 'Dashboard at the top, your SHORTCUTS, then the MENU in groups. Tap a group to open it.' });
            groups.forEach(g => steps.push({
                tourId: `group-${g.id}`, drawer: true, title: g.label,
                text: `${g.label}: ${GROUP_HELP[g.id] || ''}. Pages you can open here: ${list(g.items.map(i => i.label))}.`,
            }));
            steps.push({ tourId: 'user-card', drawer: true, title: 'You', text: 'Your name and role. Tap it for My portfolio; the red door logs you out.' });
        } else {
            steps.push({ tourId: 'menu', title: 'The menu', text: 'Every page you can use is here. Dashboard is at the top; below it are your shortcuts and the menu groups. Only one group is open at a time — the group of the page you are on opens by itself.' });
            steps.push({ tourId: 'shortcuts', title: 'Shortcuts', text: 'Your pinned pages, one click away. Click Edit, then the ★ beside any page to pin it (up to 6) or unpin it.' });
            groups.forEach(g => steps.push({
                tourId: `group-${g.id}`, title: g.label,
                text: `${GROUP_HELP[g.id] ? `${g.label[0].toUpperCase()}${g.label.slice(1)} holds ${GROUP_HELP[g.id]}. ` : ''}You can open: ${list(g.items.map(i => i.label))}. Click the group to show its pages.`,
            }));
            steps.push({ tourId: 'user-card', title: 'You', text: 'Click your name for My portfolio. The red door logs you out; « shrinks the menu to icons to give the page more room. The version of the system is shown underneath.' });
            steps.push({ tourId: 'breadcrumb', title: 'Where you are', text: 'The breadcrumb shows the group, the page and the record you are looking at. Click an earlier step to go back up.' });
        }

        steps.push({ tourId: 'search', title: 'Search', text: 'Find any page by name — and records by a person\'s name, a reference or a Public ID. Shortcut: Ctrl K (⌘K on a Mac).' });
        steps.push({ tourId: 'balances', title: 'Balances', text: 'The live balance of every company account, one click away.' });
        if (!phone && quickActions.length) {
            steps.push({ tourId: 'new', title: '+ New', text: `Start the forms you use most without hunting for the page: ${list(quickActions.map(a => a.label.toLowerCase()))}.` });
        }
        steps.push({ tourId: 'theme', title: 'Light or dark', text: 'Switch between a light and a dark screen. Your picture menu also offers "Same as my device".' });
        if (!phone) steps.push({ tourId: 'bell', title: 'Notifications', text: 'Things waiting for you, approvals, events in the next 7 days and messages. A red number means something new; click one to go straight to it.' });
        steps.push({ tourId: 'help', title: 'Help', text: 'Take this tour again, tour the page you are on, or open the manual for this page.' });
        steps.push({ tourId: 'profile', title: 'Your picture', text: 'My profile (details, signature, password, two-factor), Unfinished forms (anything you started and did not submit), My portfolio, the tours, appearance and Sign out.' });
        steps.push({ target: 'title', title: 'Every page', text: 'Each page starts with this band: its name, a line on what it is for and, on the right, its main buttons. Most pages have a row of tabs underneath.' });
        steps.push({
            title: 'You are ready',
            text: 'On any page, the (?) button or your picture › Tour this page explains that page\'s tabs and buttons. The full user manual — where to find everything and step-by-step instructions — is under Office › About, and can be downloaded as a PDF.',
        });
        return { id: 'main', title: 'Guided tour', steps };
    }, [branding?.company_name, user?.first_name, visibleItems, quickActions, isAuditor]);

    // ---- remember finished / skipped tours in the account ------------
    const remember = useCallback((id, status) => {
        const seen = { ...(user?.tours_seen || {}), [id]: { status, at: new Date().toISOString() } };
        patchUser?.({ tours_seen: seen }); // straight away, so it never starts twice
        usersAPI.markTourSeen(id, status).catch(() => { /* offline: kept on this device until next sign-in */ });
    }, [user?.tours_seen, patchUser]);

    const startMainTour = useCallback((auto = false) => {
        setTour({ ...buildMainTour(), auto });
    }, [buildMainTour]);

    const pageTour = useMemo(() => (isAuditor ? null : pageTourFor(location.pathname)), [location.pathname, isAuditor]);

    const startPageTour = useCallback(() => {
        const pt = pageTourFor(location.pathname);
        if (!pt) return false;
        const steps = [
            { title: pt.title, text: `${pt.summary || ''} Here is what is on this page.`.trim() },
            ...pt.steps.map(s => ({ ...s, title: s.title || s.tab || s.button || pt.title })),
            { title: 'More detail', text: `Step-by-step instructions for ${pt.module.title} are in the user manual: Office › About › User manual, or the (?) button › Manual for this page.` },
        ];
        setTour({ id: pt.id, title: `Tour: ${pt.title}`, steps, auto: false });
        return true;
    }, [location.pathname]);

    const close = useCallback((status) => {
        const t = tourRef.current;
        if (t) remember(t.id, status);
        setTour(null);
        if (isPhone()) setMobileOpen(false);
    }, [remember, setMobileOpen]);

    // ---- first sign-in: start by itself -------------------------------
    // Only when the account says the main tour was never finished or
    // skipped (a database without the v1.82.0 column returns no list, and
    // then the tour never starts by itself).
    const startRef = useRef(startMainTour);
    startRef.current = startMainTour;
    const seenMain = !!user?.tours_seen?.main;
    const seenKnown = !!user?.tours_seen && typeof user.tours_seen === 'object';
    useEffect(() => {
        if (autoTried.current || !seenKnown || seenMain || tour) return undefined;
        // Started a moment after the page has drawn (so the menu, top bar
        // and the page's own buttons are there to point at).
        const t = setTimeout(() => {
            if (autoTried.current) return;
            autoTried.current = true;
            startRef.current(true);
        }, 1200);
        return () => clearTimeout(t);
    }, [seenKnown, seenMain, tour]);

    // "Go there and take its tour" (About › User manual) opens a page with
    // ?tour=page: start that page's tour once the page has drawn.
    useEffect(() => {
        const sp = new URLSearchParams(location.search);
        if (sp.get('tour') !== 'page') return undefined;
        const t = setTimeout(() => {
            sp.delete('tour');
            const rest = sp.toString();
            navigate(`${location.pathname}${rest ? `?${rest}` : ''}`, { replace: true });
            setTimeout(() => startPageTour(), 50);
        }, 900);
        return () => clearTimeout(t);
    }, [location.pathname, location.search]); // eslint-disable-line react-hooks/exhaustive-deps

    // Changing page ends a running tour (the parts it points at are gone).
    const lastPath = useRef(location.pathname);
    useEffect(() => {
        if (lastPath.current !== location.pathname && tour) setTour(null);
        lastPath.current = location.pathname;
    }, [location.pathname, tour]);

    const value = useMemo(() => ({
        startMainTour: () => startMainTour(false), startPageTour, pageTour, active: !!tour,
    }), [startMainTour, startPageTour, pageTour, tour]);

    return (
        <TourContext.Provider value={value}>
            {children}
            {tour && (
                <TourOverlay
                    key={tour.id}
                    tour={tour}
                    onFinish={() => close('done')}
                    onSkip={() => close('skipped')}
                    setDrawerOpen={setMobileOpen}
                />
            )}
        </TourContext.Provider>
    );
};

const NOOP = { startMainTour: () => {}, startPageTour: () => false, pageTour: null, active: false };
export const useTour = () => useContext(TourContext) || NOOP;

export default TourProvider;
