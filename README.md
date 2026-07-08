# Classroom Buzzer

A small Jeopardy-style online buzzer app for GitHub Pages.

## What it does

- Players join a room with a room code.
- The first player to press **BUZZ** locks the round.
- The host/teacher can reset the buzzer for the next question.
- Works across phones, tablets, and laptops.
- Designed for static hosting on GitHub Pages.

## Why Firebase is needed

GitHub Pages only serves static files. It cannot coordinate live button presses between devices by itself.  
Firebase Realtime Database acts as the small live relay.

## Setup

### 1. Create Firebase project

1. Go to Firebase Console.
2. Create a new project.
3. Add a Web App.
4. Copy the Firebase config object.

### 2. Enable Anonymous Auth

Firebase Console → Authentication → Sign-in method → Anonymous → Enable.

### 3. Enable Realtime Database

Firebase Console → Realtime Database → Create Database.

Start in locked mode if Firebase asks. Then add rules like the ones in `firebase-rules.json`.

For a simple classroom deployment, use:

```json
{
  "rules": {
    "rooms": {
      "$room": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

### 4. Add your Firebase config

Open `firebase-config.js` and replace the placeholders.

### 5. Deploy on GitHub Pages

1. Create a GitHub repository.
2. Upload these files:
   - `index.html`
   - `style.css`
   - `app.js`
   - `firebase-config.js`
   - `firebase-rules.json`
3. In GitHub: Settings → Pages.
4. Set source to your main branch and root folder.
5. Open the GitHub Pages URL.

## Classroom use

1. Open the app as host.
2. Generate a room code.
3. Share the player link with students.
4. Students enter a team name.
5. Ask a question.
6. First buzz locks the board.
7. Press **Reset buzzer** for the next question.

## Notes

- Firebase config is safe to be public. Security comes from Firebase rules.
- This app is suitable for classroom use, but it is not meant for high-stakes competitions.
- Network speed can affect who reaches Firebase first. That is normal for browser-based buzzers.
