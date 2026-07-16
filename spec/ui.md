# UI spec, current behavior contracts

Extreme brevity: the heading IS the contract; add a line only when the heading can't carry it.
Edit in place, git is the history. If it needs context/alternatives, it's an ADR, not an entry.

## CS pin & status dot - raw real-time animation-frame level blinky

## "Holding" card label - debounced (~300 ms) so it doesn't flicker
Stays, useful in non-page-load contexts, e.g. during catch up when switching race/pace modes.

## Page load - fast forward the load-triggered reset and boot animations/delay so the page lands usable

## FS cards - always show both flash time and ops (both modes); only the bottom rate switches
Headline: flash time (total simNs) + ops (total) always, both modes.
Bottom rate + leader bar: Race = ops/s, Pace = per-op flash time; bar = standing on that mode's rate.

## FAT+WL die - live map resolves past the WL FTL into FAT structure; not whole-sectors-always-full
Unused pages in a file's clusters are not metadata, they read as erased/blank.
Only the actual metadata the FTL writes counts as metadata, never the sectors given to the FS layer, the FS layer decorates those.
A moved VBR looks the same, just moved, it doesn't gain extra data pages.
Writing a file partially fills tail pages and leaves pages it didn't have to write blank.
Writing a file doesn't change the display of previous file regions (unless the WL dummy moved over one).

## Header Reset - never switches race/pace mode; replays in whatever mode is set

## FS card rates - always sim time, never wall clock; smoothing is a fixed window in sim time
ops/s = ops per simulated flash-second (speed-invariant); the EMA decays in sim time so the slider never changes the reading.
