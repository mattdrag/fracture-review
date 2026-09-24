# Fracture Pod Review

Grade Reality Fracture (FRA) for limited with your friends, each on your own time, then compare.

## 1. Set up the database (Supabase, free, ~5 min)
1. Sign up at https://supabase.com and create a new project.
2. Open **SQL Editor**, paste the contents of `schema.sql`, and click **Run**.
3. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key into `config.js`.

The anon key is designed to be public. Anyone with the site link can read and write reviews, which is fine for a friend group.

## 2. Put it online (pick one)
- **Netlify Drop (easiest):** go to https://app.netlify.com/drop and drag the `fracture-review` folder onto the page. You'll get a link to share.
- **GitHub Pages:** create a repo, upload these files, then go to **Settings → Pages → Deploy from branch → main**. The site appears at `https://<you>.github.io/<repo>/`.

## How it works
- Everyone enters a name. Using the same name later picks up the same review.
- Grades go from A+ to F by color (White, Blue, Black, Red, Green, Gold, Colorless), with optional notes. Grades save automatically.
- **Results** unlock for you once you submit, so everyone grades independently first.
- Cards where grades differ by at least the chosen threshold (default: 4 steps, like B vs C-) are marked **discuss**. Grades are anonymous unless you check "Show who gave which grade."
- Card data and art come live from Scryfall.
