"""Offline farm calibration: replay history through FarmOpti's generic transitions."""

__all__ = ["main"]


def main() -> None:
    from farm_calibration.__main__ import main as cli_main

    cli_main()
