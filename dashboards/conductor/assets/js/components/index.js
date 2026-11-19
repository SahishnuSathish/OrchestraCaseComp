// Conductor component library. Every export returns DOM nodes built with lib.js's h(); class names use the c- prefix.
// The live catalogue with every variant is the style guide: /app#/styleguide (CFO only).
export { icon, ensureIcons, ICON_NAMES } from './icons.js';
export { mark, lockup, PRODUCTS, TAGLINES } from './marks.js';
export { button, iconButton, setBusy, field, setFieldError, checkbox, nextId } from './controls.js';
export { badge, outcomeBadge, riskBadge, riskBadges, contactBadge, statusBadge, chip, sourceChip, dot, avatar, initials } from './badges.js';
export { table, fmtMoney, stat, timeline, skeleton, skeletonRows, skeletonText, reading, empty, notice } from './data.js';
export { pane, split, tabs } from './layout.js';
export { menu, openMenu, closeMenu, modal, toast, progress } from './overlays.js';
export { directShell } from './direct-shell.js';
