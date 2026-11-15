# Process Annotation · Work Standardization & Kaizen

Record a station on your phone → a Standardized Work Chart and a step-wise breakdown.

## Run (Windows)

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env      # then put your Gemini API key in .env
python run.py               # opens on http://127.0.0.1:8000
```

ffmpeg is bundled through `imageio-ffmpeg`; nothing else to install.
Try the UI without an API key: set `WORKSTUDY_ENGINE=mock` (synthetic steps, not real analysis).

## What it produces

From a handheld phone video of a station, two outputs:

1. **Standardized Work Chart** (PDF / PNG): top view of the station drawn on a grid like the paper
   form. Bins are shaded circles, benches and fixtures boxes, equipment crossed-out boxes. Every
   step of the instruction cycle is a numbered circle at the place the hands go, with arrows in step
   order (dashed where the operator walks). Header: job, from / to, date, line/operation. Footer:
   quality and safety symbols, standard in-process stock, takt, cycle time.
2. **Manual Time Observation Sheet** (PDF and XLSX), laid out like the paper form: Job/From,
   Content/To, Line/Operation, Date, Shift, Takt, Prepared by, Operator; # | Work Element | Break
   Point | cycles 1-10 | Lowest Repeatable | t adjusted | Highest | Fluctuation | Comments; Σt and
   T - Σt; legend. The PDF circles the highest value, underlines the lowest repeatable and crosses
   out excluded cycles. Whole seconds by default, rounded half up; an element that happened is
   never written as 0. Set WORKSTUDY_SHEET_DECIMALS=1 for tenths.
3. **Step-wise breakdown** (second sheet of the XLSX, and on screen): Step # | Step description |
   Location | Hand | Time (s) | Value-add / Non-value-add | Transcript. Same numbers as the chart.

Buttons: Work chart (PDF), Time observation (PDF), Time observation (XLSX), Export all (zip).

Elements are split like a time observation sheet (one hand action at one place: "Grab part",
"Place part", "Grab drill"). WORKSTUDY_STEP_DETAIL=coarse gives larger work-instruction steps.

## How it works

All video understanding is Gemini; there is no computer-vision tracking or pixel measurement.

1. **Layout pass**: Gemini maps the station from the operator's viewpoint as categories only:
   type, column (far left … far right), row (back / middle / front), shelf (top / middle /
   bottom for stacked bins) and left-to-right order. Code turns these into chart positions.
2. **Steps pass**: cycles, steps, times, and for every step the place (`location_id`) where the
   hands go. Locations are checked: a reference that is not in the layout is matched to the
   nearest label, or left empty with a warning so you can set it.
3. Consecutive steps merge only when they have the same element in the same cycle with nothing in
   between, never because titles look alike.

Check the layout on the Work chart tab and correct a column, row, shelf or order if needed; the
chart redraws and the layout is saved for the station (project + line/operation), so the next
study of that station reuses it. Set a step's location on the Step breakdown tab.

After a run, `python check_study.py` prints the layout, each step's location and three checks:
every step has a valid location, chart numbers = breakdown numbers, no overlaps on the chart.

The earlier modules (work instructions, time study, Kaizen, Copilot, line balancing) are still in
the code. Set `WORKSTUDY_UI=full` in `.env` to show them.

## Accuracy, editing and units

- **Tenths of a second** everywhere (4.9, 5.1). Each break point is a clock reading rounded to
  0.1 s and an element is the difference of two readings, so elements always add up to the cycle.
  `WORKSTUDY_SHEET_DECIMALS=0` switches back to whole seconds.
- **Reference cycles** (Station template tab): mark your break points in up to 3 clean cycles
  (M = mark, arrows = 0.1 s). Gemini gets a picture of every break point. Each marked cycle is
  also timed blind (it never sees its own pictures), and the tab shows the measured error:
  your mark vs Gemini, per element.
- **Alignment (free, local)**: with reference cycles marked, every cycle is also matched frame
  by frame to them (DINOv2-small, about 90 MB, downloaded once into `data/models`; runs on the CPU)
  and your break points are carried over. **Re-time from marks (free)** on the Station template tab
  does this without calling Gemini. Both Gemini and alignment time each marked cycle blind; per
  element the one closer to your marks is used, and alignment is only used where its measured error
  is at most 1 s. Readings where the two disagree by more than 1 s are marked ?. Alignment works
  best on a fixed camera: on handheld video the picture changes with the camera angle, not only with
  the work. On the 11-minute handheld test video it agreed with Gemini within 0.5 s on the clearly
  visible early elements (3-8) and disagreed by several seconds on the late "pick part / insert
  part" elements; only your marks can say which is right there, which is why both are measured.
  Reading frames is slow on a laptop CPU (the 11-minute video took about 15-70 min at 2 frames per
  second, depending on power mode; `WORKSTUDY_ALIGN_FPS`). It runs while Gemini works and is cached
  per study, so re-timing afterwards takes seconds.
- **Models**: element timing per cycle, the precision pass (high-resolution frames) and sheet photos use
  `WORKSTUDY_TIMING_MODEL` (default setup: Gemini 4 Argon, Google's strongest); finding cycles, the
  layout and transcripts use `WORKSTUDY_GEMINI_MODEL` (Gemini 3.8 Flash); Teach, descriptions and chat
  use `WORKSTUDY_COPILOT_MODEL` (Argon). If the strong model fails on a call, that call falls back to
  Flash. Cost: about $5-6 per 11-minute video with Argon (about $1-1.50 all-Flash); Google's announced
  price changes (Argon from 2026-12-01, Flash from 2027-01-01) roughly double both.
- **Timing passes**: 1) cycles and suggested X on the whole video; 2) each cycle's clip at 8 fps
  with your elements and example pictures; 3) precision pass: every break point again in a 3 s
  window at 10 fps (`WORKSTUDY_REFINE=0` turns it off). Readings Gemini cannot see stay blank.
- **X is a suggestion** until you tick it (Time study sheets tab). Readings far from an element's
  typical time are marked ? and kept out of lowest/highest unless Gemini saw a reason.
- **Edit in the app**: step times per cycle (Step breakdown → Edit step times: Start = playhead,
  ±0.1 s, not visible); the work chart (Work chart → Edit chart: places, order, walking, quality ◇
  and safety ⊕ marks, drag the layout); study details (✎ Details: takt, operator, SWIP, shift).
  Edited times count as checked.

## Teach it (feedback)

The **Teach** button (bottom right of every study) takes feedback in plain words: "those bins are
slightly closer together", "element 5 starts when the screw touches the part", "make the step
descriptions more detailed". It answers with the exact changes (before -> after) and the
instructions it would remember; nothing changes until you tick and apply them.

- Layout and chart: places moved or re-spaced, renamed, re-typed; element places, hands, walking,
  quality/safety marks. Element wording only changes when you ask for a rename.
- Timing: break points you reword and notes per element go into every later timing of the station.
- Descriptions: written for every element in the style you ask for; shown in the step breakdown and
  exports.
- Remembered instructions are listed on the Station template tab (What it has learned) and can be
  deleted. They are added to the AI prompts for every later analysis of that station.

## Accounts, teams and hosting

Locally the app runs without accounts. With `WORKSTUDY_AUTH=1` (default in the Docker image) people
sign up with email and password and either start a team or join one with its invite code (shown in
the sidebar). Each team's studies and templates live in their own folder under `DATA/workspaces/`.
`WORKSTUDY_SIGNUP_CODE` is the access code needed to start a new team (share it with the link), and
`WORKSTUDY_MONTHLY_ANALYSES` caps paid video analyses per team per month (default 30).

**Deploy on Render** (one service with a persistent disk, about $7/month plus disk):
1. Push this folder to a private GitHub repository (`.env`, `data/` and `.venv/` are git-ignored).
2. Render dashboard > New > Blueprint > pick the repository. `render.yaml` sets everything up.
3. When asked, paste `GEMINI_API_KEY` and choose a `WORKSTUDY_SIGNUP_CODE`.
4. Share the `https://process-annotation-xxxx.onrender.com` link and the access code.

The `Dockerfile` runs anywhere that gives a container a persistent volume at `/data` (Railway,
Fly.io, a company VM). Keep one instance: analyses run in the web process.

## Data and privacy

The Gemini engine uploads the proxy video to Google. Get sign-off before using real factory
footage. Uploaded files are deleted from Gemini after analysis. Everything else stays in `data/`.

## Known limits

- Timing comes from the model, sampled at `WORKSTUDY_FPS`. Expect errors around ±0.5–1 s on
  short elements. Verify flagged steps before using the numbers for a standard.
- The work chart is a schematic from categories (column / row / shelf), not a measured floor plan.
  Positions are only as good as the layout pass; check them against the station.
- Splitting a step creates a new element in that cycle only; other cycles are not re-aligned.
- The engine interface (`app/engine.py`) is where a local CV engine (MediaPipe + bench zones)
  would plug in to keep video on the laptop.
