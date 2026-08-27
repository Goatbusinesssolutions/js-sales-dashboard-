// Known GHL userId -> display name, for the sales rep leaderboard.
// This is a cache, not a source of truth: any assignedTo id NOT in this map
// gets looked up live via GET /users/{id} and the result is merged in at
// request time (see ghlClient.getUserName). Update this map whenever you
// want to skip that extra lookup for a rep you already know, or when GHL
// rep accounts change.
//
// Flag: as of the last audit (Aug 2026), a few of these accounts carry very
// restricted GHL permissions (appointments-only, no contacts/opportunities
// access) and look more like install/production crew than sales reps.
// assignedTo can shift when a deal moves into a fulfillment pipeline, so
// dollars attributed to these names in the YEAR view especially may reflect
// production assignment rather than the original point of sale on older
// deals. Worth a gut-check if the leaderboard ranking looks off.
//   - John Hampton   (f0e4KWU4OW7S3x68QXpF)
//   - Dwight Smith   (k3x3rbF64i9pl84u4vyC)
//   - Mike Austin    (fBt8K02bdYtrdCB3biyf)
//   - Bryan Woodlief (2gXoeFuHQkpZp3tZnXFq)

export const repNames = {
  '1w9VBrLtbi6cU38PDR0c': 'Grant Caudill',
  'vie61BxuuqXjznzutNUO': 'Tim Brewster',
  'OQ9qrgwW6yvHi6DAdrS3': 'Wil Munk',
  'P7hObs3CTmOo8aNLtJIO': 'Chris Cole',
  'xgKRP9GiY99FY5dhilJX': 'Jacob McReynolds',
  'qbXnsv0iKEyDKoPPosVf': 'Brandon Cole',
  'u2zOxdLZxLhKjQtkX2QM': 'Toni Bovino',
  'GKvS8vfGkvF71pZv4601': 'Josh Cole',
  'MjKweid3PoPtOIlhYSQT': 'Michael Costa',
  'CvEuqoB38Zm8Zmjg9XJ7': 'Rebecca Clegg',
  'f0e4KWU4OW7S3x68QXpF': 'John Hampton',
  'k3x3rbF64i9pl84u4vyC': 'Dwight Smith',
  'fBt8K02bdYtrdCB3biyf': 'Mike Austin',
  'vktQMPuUAdqXE1mniOvp': "Morgan O'Quinn",
  '2gXoeFuHQkpZp3tZnXFq': 'Bryan Woodlief',
};

export default repNames;
