# Alia

Alia is a Manifest V3 tab-suspension extension. It keeps discarded tabs in their original tab-strip position and stores all learning and configuration in `chrome.storage.local`.

## Load

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.

## Local storage schema

`aliaTabState` is keyed by Chrome tab id. Each record contains `lastActiveAt`, `lastInactiveAt`, `hostname`, `stage`, `suspendedAt`, and `estimatedMemoryMb`.

`aliaDomainHistory` is keyed by hostname. Each value stores the latest 20 `returnIntervalsMs` samples and `lastReturnedAt`. The median sample selects a 10, 15, 20, or 25 minute suspension grace period.

`sensitiveDomains` is the local array of hostname suffixes. It is seeded with bundled banking, healthcare, government, and webmail defaults on installation, can be edited from the side panel or context menu, and never syncs or leaves the browser.

`aliaSuspensionStats` stores the current `estimatedMemoryFreedMb`, lifetime `totalSuspensions`, and `lastUpdatedAt`.

## Permission boundary

The manifest deliberately requests only `tabs`, `storage`, `contextMenus`, and `sidePanel`. The toolbar icon opens Alia's docked side panel. Chrome does not expose the tab-strip hover event or a way to style a tab title/favicon directly; Alia uses per-tab action badges and tooltips for the dim warning and restores on tab activation/click.

With no host permission, scripting permission, or content script, Alia cannot read form state or detect uploads. It never inspects page DOM, skips audible tabs using `tab.audible`, and only acts on inactive, unpinned `http` and `https` tabs. Sensitive tabs use an extension-owned placeholder that receives only the original URL and reloads that URL when restored.

The MV3 worker uses a best-effort in-worker one-minute evaluation timer because the requested permission set excludes `alarms`. It also reevaluates on browser startup and tab lifecycle events.
