---
name: camsnap
description: Screen and camera capture for screenshots and webcam snapshots
emoji: "\U0001F4F7"
version: "1.0.0"
os:
  - darwin
  - linux
invocation:
  userInvocable: true
---

# CamSnap (Screen & Camera Capture)

Capture screenshots of the screen or specific windows, and take snapshots from a connected camera/webcam.

## Usage
- "Take a screenshot of my screen"
- "Capture the current Chrome window"
- "Take a screenshot of the region around the top-left corner"
- "Snap a photo from my webcam"
- "List available displays"
- "Screenshot my second monitor"

## How it works
Uses platform-native screen capture tools and optional camera utilities to produce image files.

### macOS
- **Screenshots:** Uses the built-in `screencapture` command.
  - Full screen: `screencapture output.png`
  - Specific window (interactive): `screencapture -w output.png`
  - Region: `screencapture -R x,y,w,h output.png`
  - Specific display: `screencapture -D <display_id> output.png`
- **Camera:** Uses `imagesnap` to capture a frame from the default or a specified camera device.
  - Snap: `imagesnap output.jpg`
  - List devices: `imagesnap -l`

### Linux
- **Screenshots:** Uses `scrot` or ImageMagick `import`.
  - Full screen: `scrot output.png`
  - Focused window: `scrot -u output.png`
  - Region: `import -window root -crop WxH+X+Y output.png`
  - With selection: `scrot -s output.png`
- **Camera:** Uses `ffmpeg` to grab a single frame from a video device.
  - Snap: `ffmpeg -f v4l2 -i /dev/video0 -frames:v 1 output.jpg`
  - List devices: `v4l2-ctl --list-devices`

All captured images are saved to the current working directory or a specified path.

## Setup

### macOS
`screencapture` is built-in. For camera capture, install imagesnap:
```
brew install imagesnap
```

### Linux
Install one of the screenshot tools and optionally ffmpeg for camera:
```
sudo apt install scrot ffmpeg
```
