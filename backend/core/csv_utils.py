import csv
import re


_NUMERIC_CELL = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)\Z")


class SafeCSVWriter:
    def __init__(self, response):
        self.writer = csv.writer(response)

    def writerow(self, values):
        safe_values = []
        for value in values:
            if isinstance(value, str):
                candidate = value.lstrip(" \t\r\n\v\f\ufeff")
                if candidate.startswith(("=", "+", "-", "@")) and not _NUMERIC_CELL.fullmatch(candidate):
                    value = "'" + value
            safe_values.append(value)
        self.writer.writerow(safe_values)