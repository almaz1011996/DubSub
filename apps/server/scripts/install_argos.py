import argostranslate.package as pkg


def main() -> None:
    pkg.update_package_index()
    available = pkg.get_available_packages()
    target = next(p for p in available if p.from_code == "en" and p.to_code == "ru")
    pkg.install_from_path(target.download())
    print("installed en->ru")


if __name__ == "__main__":
    main()
