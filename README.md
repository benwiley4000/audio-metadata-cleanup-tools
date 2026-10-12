# audio-metadata-cleanup-tools

These are tools I use to correct and organize metadata in my MP3/M4A collections.

No test coverage, no guarantee that these will not screw up your files. I've still made care to only include scripts that worked for me and did not mess up my data.

## Requirements

- NodeJS for most scripts
- You might need to install some linux packages, you'll see when you run the scripts

Run `npm install` inside the cloned directory to install all the necessary node dependencies.

## Analysis (read-only) tools

### `check-charset.js`

This identifies all the MP3 files in a directory whose ID3 metadata includes fancy characters which might display poorly in some mp3 players

Usage:

```sh
node check-charset.js <path-to-music-library-root> 
```

### `list-tags.js`

This lists id3 tags by track for a folder full of MP3s

Usage:

```sh
node list-tags.js <path-to-music-library-root> 
```

## Tools for flattening track numbering for multi-disc albums

My MP3 player doesn't handle track numbering well across multi-disc albums, so my solution is to use linear numbering across all discs (while maintaining the disc numbering metadata). So 3 CDs with tracks 1-20 will become tracks 1-60. I have a handful of scripts for helping with this.

### `consolidate.js`

A lot of my MP3 music is initially organized into multiple CD subfolders, like this:

```
LibraryRoot/
  Artist/
    Album/
      01. Track.mp3
      02. Track.mp3
    Multi-CD Album/
      CD 1/
        01. Track.mp3
      CD 2/
        01. Track.mp3
      Covers/
        front.jpg
```

`consolidate.js` renumbers all the disc 2+ tracks into a linear ordering with disc 1, and flattens them into a common top-level folder. Note that if your tracks don't have Disc + track number file name prefixes, you now won't be able to order them correctly in a regular file explorer. Music player apps should be fine because they sort by ID3 metadata.

Usage: 

```
node consolidate.js "/path/to/LibraryRoot"           # dry run (default, no changes)
node consolidate.js "/path/to/LibraryRoot" --apply    # actually do it
```

### `fix-disc-numbering.js`

This does exactly the same thing as consolidate.js but for a folder of multi-disc MP3s that are already flattened, NOT organized into subfolders.

```
node fix-disc-numbering.js "/path/to/LibraryRoot"           # dry run (default, no changes)
node fix-disc-numbering.js "/path/to/LibraryRoot" --apply    # actually do it

```

### `padall.sh`

After you renumber a bunch of multi-disc tracks (or perhaps even in some other cases), you can have track numbers that don't all contain the same number of characters. My mp3 player sorts track numbers alphabetically, so they need the correct number of leading 0s so all track numbers have the same number of characters. This script fixes that.

Usage:

```sh
./padall.sh "/path/to/LibraryRoot" # dry run
./padall.sh "/path/to/LibraryRoot" --write # do it
```

### `renumber-m4a.js`

This is the same as fix-disc-numbering.js but it works on a folder of M4A files (multi-disc albums exported from iTunes).

Usage:


```
node renumber-m4a.js "/path/to/LibraryRoot"           # dry run (default, no changes)
node renumber-m4a.js "/path/to/LibraryRoot" --apply    # actually do it

```

## Restoring gapless playback info for MP3s converted from FLAC

On Linux I use the Sound Converter app to convert flacs to MP3, but it doesn't properly create the LAME header that includes information for gapless players (delay + padding). In the ./gapless-restore folder I have a script that corrects this, but it requires you to organize folders of source flacs and converted MP3s, so the MP3s can be corrected by cross-referencing the FLACs. The mp3 and flac files need to have the same names (ignoring the extensions).

Usage:

First, carefully organize your music that needs gapless info added as so:

```
audio-metadata-cleanup-tools/
  gapless-restore/
    add-gapless.js
    .gitignore
    Some Album/
      mp3/
        01. Track1.mp3
        02. Track2.mp3
        03. Track3.mp3
      flac/
        01. Track1.flac
        02. Track2.flac
        03. Track3.flac
    Another Album/
      mp3/
        01. Track1.mp3
        02. Track2.mp3
        03. Track3.mp3
      flac/
        01. Track1.flac
        02. Track2.flac
        03. Track3.flac
```

Then run:

```sh
node ./gapless-restore/add-gapless.js ./gapless-restore
```

This will update the headers for all the MP3 files that match a corresponding flac file in the adjacent folder.

## Notes about other tools I use

- To fix other problems with MP3 metadata I use [Puddletag](https://github.com/puddletag/puddletag) which can run either locally or on a server via a docker container (with streamed UI).
- As mentioned, to convert individual flacs to MP3 I use [Sound Converter](https://soundconverter.org/)
- To convert whole-CD flacs to individual MP3s I use [Flacon[(https://flacon.github.io/)
