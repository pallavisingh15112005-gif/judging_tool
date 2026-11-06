# judging tool

A small web app for judging events. Judges enter scores for each criterion and the totals + ranks update on their own.

No backend, no npm install, no build step. Just 3 files.

## what it does

- multiple judges and multiple participants
- each criterion has its own min, max and weight
- totals are normalised to 0-100 so criteria with different ranges can be compared
- ranks update live, ties get the same rank (1, 1, 3)
- leaderboard shows each judge's total next to the overall score
- per-criterion score breakdown
- csv export and print / pdf
- dark and light theme
- autosave in localStorage

## run

Open `index.html` in a browser. Thats it.

If localStorage acts weird on `file://`, serve it locally instead:

```bash
python -m http.server 8000
```

then open http://localhost:8000

## scoring

Percentage for one criterion:

```
(score - min) / (max - min) * 100
```

Judge total:

```
sum(percent * weight) / sum(weight)
```

Participant overall score is the average of all judges totals.

Example: weights `1, 2, 1`, scores `8, 9, 7` on a `1-10` scale
-> `(77.8*1 + 88.9*2 + 66.7*1) / 4 = 80.6`

Missing criteria are skipped until the judge finishes that scorecard, so a half filled card doesnt drag the total down.

## files

```
index.html   markup, 3 tabs (setup / scoring / results)
styles.css   theme and layout
app.js       state, math, rendering, csv
```

## hosting

Github Pages works fine since there is no build step:
Settings -> Pages -> deploy from branch -> `main` / root.

## notes

- Data is saved in the browser only (localStorage key `judging-tool.v1`). Different browser or device = no data.
- Use export csv if you need to move results around.
- "Clear all scores" keeps the setup. "Reset project" brings back the sample data.
