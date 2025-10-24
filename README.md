# Simple Notepad (Node, no DB)

A super-minimal shared notepad served at http://localhost:6969

- No database (stores content in `data/notepad.txt`)
- Auto-saves on input
- Real-time sync across browsers via Server-Sent Events (SSE)
- Only a full-page textarea, no extra UI

## Run

Requirements: Node.js 18+

```bash
npm start
```

Then open:

- http://localhost:6969

## Notes

- Content is kept in `data/notepad.txt` in the project folder.
- If multiple people type at once, last write wins; changes propagate instantly to all open pages.
- The server supports simple CORS for the endpoints.
