---
name: build-two-event-case-study-slides
description: "Create or update editable PowerPoint event-achievement decks in the user's established two-events-per-page format. Use when the user asks for apparel, cosmetics, pop-up, exhibition, activation, or experiential-marketing case studies; asks to place two event examples on each slide; or wants a new deck matching the bundled reference presentation. Preserve the restrained Natural Making Slides approach: white space, Yu Gothic bold typography, direct copy, minimal decoration, face-safe crops, real event photography, and render-based visual QA."
---

# Build Two-Event Case Study Slides

Create a clean, editable 16:9 PowerPoint with two equally weighted event cases on each content slide. Use the bundled deck as the structural source and the established Natural Making Slides principles as the quality bar.

## Required reading

1. Read the PowerPoint skill completely (in Claude: the `pptx` skill; in ChatGPT: the Presentations skill). If a `natural-making-slide` skill is available, read it too and follow it alongside this one.
2. Read `references/format-spec.md` before planning or editing.
3. Use `assets/two-event-case-study-reference.pptx` as the source deck unless the user provides a newer deck to follow. Open it with python-pptx and duplicate its slides; do not rebuild the layout from scratch.
4. Deliver the result as an editable `.pptx` file, even when a slide-artifact type is available, because this format depends on the reference deck's exact geometry.

## Workflow

1. Confirm the event list and grouping from the request or supplied material. Do not add a cover or section divider unless the user asks for a full deck rather than isolated case-study pages.
2. Resolve facts for every case: official event name, concise overview, exact date, venue, and one representative image. Prefer organizer, brand, venue, or agency primary sources. Never infer missing dates, venues, attendance, client names, or production roles.
3. Keep a compact source ledger while researching. Put source URLs in speaker notes when creating the deck. Do not clutter the visible slide with long URLs unless requested.
4. Duplicate and edit existing reference slides instead of rebuilding their geometry. Preserve slide size, margins, dividers, label positions, image boxes, page numbering, typography, and accent logic.
5. Write one factual sentence for each overview. State what visitors could see or do. Remove promotional claims and vague adjectives.
6. Use actual event photography. Do not generate a fake photograph of a real activation, brand, product, venue, or visitor scene. Preserve logos and products without distortion.
7. Keep all text, labels, and images editable. Preserve the source image aspect ratio and crop with `cover`; never stretch.
8. Render the complete result. Inspect every slide at a consistent readable size, then fix overflow, awkward line breaks, distorted crops, misalignment, tiny text, or inconsistent spacing. Re-render after corrections.

## Natural Making Slides rules to preserve

- Use one flat composition, not cards, dashboards, pills, shadows, gradients, or decorative UI.
- Favor white background, black or dark-gray text, one controlled accent color, and generous margins.
- Use Yu Gothic (`游ゴシック`) in bold for every visible text element. Do not substitute another font in the editable PowerPoint unless the user explicitly requests it.
- Keep titles direct. Avoid slogans, imperative titles, excessive English labels, and AI-like marketing language.
- Let one strong event photograph carry each half. Do not fill white space with icons or ornamental shapes.
- Keep text short enough to read without zooming. Cut copy before reducing type.
- Maintain strict alignment and equal visual weight between the two cases.
- Use only verified facts. If evidence is missing, omit the claim or label it clearly; never make it look confirmed.
- Deliver an editable presentation, not flattened slide images.
- Treat render review as mandatory, not optional.

## Content rules

For each event, include only:

- Official event name
- `開催概要`
- `概要`: one sentence, normally 35–65 Japanese characters
- `日時`: exact date or date range
- `場所`: official venue name and useful floor or area details when verified
- One representative event image

Do not add `クライアント`, `目的`, `商材`, `来場者数`, `担当範囲`, or `成果` unless the user supplies or explicitly requests them and they are verified.

## Page construction

- Pair related cases by category, period, or experience type.
- Keep left and right cases equal in width and hierarchy.
- Use one image per case by default. A collage requires the user's request or a clear evidence need.
- Position and crop photographs so no frame edge cuts through a person's face or head. When a face is too close to an edge, change the crop or select another verified image rather than accepting the cut.
- Keep the center divider and the single page number.
- When the event count is odd, never invent a filler case. Use the left half and leave the right half intentionally blank, or ask the user for one more case when interaction is possible.
- For category covers, reuse the reference cover or divider slide. Change only text, accent color, and the supplied background image.

## Quality gate

Before delivery, verify all of the following:

- Every case has a primary or authoritative source.
- Event names, dates, and venues match those sources.
- No unsupported statement implies the user's company produced the event.
- Every content page contains at most two cases.
- Titles, photos, labels, field rows, and dividers align to the reference grid.
- Font size and line breaks remain legible at normal presentation view.
- Images are real, relevant, correctly cropped, and not stretched.
- No text or shape overlaps another object or the slide edge.
- Page numbers progress correctly.
- The deck opens, remains editable, and has been rendered and visually inspected in full.

## Output behavior

Return the finished presentation and mention only limitations that affect use. Do not narrate routine checks. Do not modify or replace any other personal skill, including Natural Making Slides.
