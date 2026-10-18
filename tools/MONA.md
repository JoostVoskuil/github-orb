# Mona news assets

Run `npm run prepare:mona --prefix tools`, `npm run render:mona --prefix tools`,
then `npm run export:firmware --prefix tools`. Preparation is pinned, not a
refresh of the existing Copilot source. Rendering merges into manifest version
1; neither render command removes the other character's clips or provenance.
Run `npm test --prefix tools` and `npm run verify:mona --prefix tools` after
export. The latter checks decoded browser pixels; it is not a visual review.

`mona-idle`, `mona-thinking`, `mona-tool`, `mona-pr`, and `mona-offline` are
transparent 320×320, 96-frame, 12-fps eight-second loops (`2560×3840` WebP
atlases) that mimic Copilot's resting, thinking, working, needs-input, and
offline motions. `mona-done`, `mona-workflow`, and `mona-security` are
transparent 320×320, 36-frame, 12-fps three-second one-shots (`2560×1600` WebP
atlases) for completion, workflow error, and Scared Mona (security alerts);
their motion finishes at 2.5 seconds, leaving six stable closing frames.
Playback clamps one-shots to the final frame. Posters are 320×320 PNGs.
Backgrounds, labels, rings, and news text are deliberately not baked into the
character.

Integration contract (implemented by the bridge/dashboard/firmware owners):
`mascot: 'mona'`, `clip` equal to one of these names, integer `presentationId`
revision, and `alert: { id, kind, title, url, repository }`. PR uses mood
`needsInput` (`mona-pr`); workflow failure uses `error` (`mona-workflow`);
security alert uses Scared Mona (`mona-security`). Select by `clip`, not by
mood, and restart only for a new presentation revision. The ORBA version-1 pack
contains all fifteen named clips (seven Copilot clips and eight Mona clips).
These asset tools do not emit bridge events or modify playback clients.

## Source and adaptations

Retained source: `media/mona/source.3mf`, from Martin Woodward and contributors'
octoprints, revision `981a85f0bec9d1a9c280fd5719d0d797852229c4`,
`models/mona/mona_multicolor.3mf`. See `source.json` for SHA-256 and attribution,
and `LICENSE.txt` for the original CC BY-NC 4.0 license. Noncommercial use only;
commercial distribution requires separate permission. No GitHub affiliation or
trademark permission is implied.

The component transform is identity. The print-bed transform is retained as
metadata but not applied to the display mesh. Its intrinsic Z-up, negative-Y
front is rotated -π/2 around X. Source filament colors are violet, white,
black, and pink. Normals are calculated on the welded whole mesh before
material separation. This is an unrigged print model: gestures rotate the
whole character without stretching its face or adding an artificial eye rig.

Seven of 15,000 faces contain Bambu split-paint trees. The importer decodes
their leaves and assigns the modal filament to the tiny original face (ties
use the lowest index), an explicitly recorded display simplification, not
an exact reconstruction of the printer's paint subdivision. Original paint
strings and the untouched source archive are retained. Unrecognized colors,
truncated trees, unexpected palettes/transforms, or mesh counts are rejected.