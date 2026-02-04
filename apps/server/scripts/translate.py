import argparse
import re
import argostranslate.translate as translate


def parse_srt(text: str):
    blocks = re.split(r"\n\s*\n", text.replace("\r", "").strip())
    entries = []
    for block in blocks:
        lines = block.split("\n")
        if len(lines) < 2:
            continue
        idx = 0
        if lines[0].strip().isdigit():
            idx = 1
        time_line = lines[idx]
        body = lines[idx + 1 :]
        entries.append((time_line, body))
    return entries


def write_srt(entries, path: str):
    with open(path, "w", encoding="utf-8") as f:
        for i, (time_line, body_lines) in enumerate(entries, 1):
            f.write(f"{i}\n")
            f.write(time_line + "\n")
            f.write("\n".join(body_lines).strip() + "\n\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_srt")
    parser.add_argument("output_srt")
    args = parser.parse_args()

    with open(args.input_srt, "r", encoding="utf-8") as f:
        srt_text = f.read()

    translation = translate.get_translation_from_codes("en", "ru")
    if translation is None:
        raise RuntimeError(
            "No Argos translation model for en->ru. Install it first: "
            "python -m argostranslate.package install "
            "https://github.com/argosopentech/argos-translate/releases/latest/download/translate-en_ru.argosmodel"
        )

    entries = parse_srt(srt_text)
    translated_entries = []
    for time_line, body_lines in entries:
        translated_lines = []
        for line in body_lines:
            line = line.strip()
            if not line:
                translated_lines.append("")
                continue
            translated_lines.append(translation.translate(line))
        translated_entries.append((time_line, translated_lines))

    write_srt(translated_entries, args.output_srt)


if __name__ == "__main__":
    main()
