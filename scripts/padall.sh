#!/bin/bash

DRY_RUN=true
TARGET_DIR="."

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case "$1" in
        -w|--write)
            DRY_RUN=false
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [-w|--write] [target_directory]"
            echo "  -w, --write    Apply changes in-place (default is dry run)"
            echo "  -h, --help     Display this help message"
            exit 0
            ;;
        *)
            TARGET_DIR="$1"
            shift
            ;;
    esac
done

# Check for required tools
if ! command -v ffprobe &> /dev/null; then
    echo "Error: 'ffprobe' is required to read tags."
    exit 1
fi

if ! command -v mid3v2 &> /dev/null; then
    echo "Error: 'mid3v2' (from python3-mutagen) is required to edit tags safely."
    echo "Install it via:"
    echo "  Ubuntu/Debian: sudo apt install python3-mutagen"
    echo "  macOS:         brew install mutagen"
    exit 1
fi

if [ "$DRY_RUN" = true ]; then
    echo "=== DRY RUN MODE (No changes will be saved) ==="
    echo "To apply changes, run with: $0 --write"
    echo "========================================"
fi

echo "Scanning for unpadded track numbers in: $TARGET_DIR"
echo "========================================"

find "$TARGET_DIR" -type f -iname "*.mp3" -print0 | while IFS= read -r -d '' file; do
    # Read the current track number
    track=$(ffprobe -loglevel quiet -show_entries format_tags=track -of default=noprint_wrappers=1:nokey=1 "$file")
    
    # Strip any trailing carriage returns sometimes found in ID3 tags
    track=$(echo "$track" | tr -d '\r')
    
    # Skip if no track tag exists
    if [ -z "$track" ]; then
        continue
    fi
    
    # Split into number and total (handles both "1" and "1/12" formats)
    track_num="${track%/*}"
    track_total="${track#*/}"
    
    # If no slash was found, total will equal num. Clear the total.
    if [ "$track_num" = "$track_total" ]; then
        track_total=""
    fi
    
    # Ensure track_num is a valid digit string to prevent errors on weird tags
    if ! [[ "$track_num" =~ ^[0-9]+$ ]]; then
        continue
    fi
    
    # Zero-pad the track number to 2 digits.
    # The '10#' forces base-10 evaluation so bash doesn't choke on numbers like "08".
    padded_num=$(printf "%02d" $((10#$track_num)))
    
    # Only modify the file if the padding actually changes something
    if [ "$track_num" != "$padded_num" ]; then
        # Reconstruct the track tag (with or without the total)
        if [ -n "$track_total" ]; then
            new_track="$padded_num/$track_total"
        else
            new_track="$padded_num"
        fi
        
        if [ "$DRY_RUN" = true ]; then
            echo "[DRY RUN] Would fix: [ $track -> $new_track ] - $(basename "$file")"
        else
            echo "Fixing: [ $track -> $new_track ] - $(basename "$file")"
            # Write the new track tag in-place using mid3v2
            mid3v2 -T "$new_track" "$file" > /dev/null
        fi
    fi
done

if [ "$DRY_RUN" = true ]; then
    echo "========================================"
    echo "Dry run complete. Run '$0 --write' to apply these changes."
else
    echo "Done! All track numbers are now zero-padded."
fi