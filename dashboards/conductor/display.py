"""Display names for record values that read badly on screen. Records are never changed; only what people see.

The data pack names Orchestra's paying entities "Mock Agency East LLC", "Mock Agency West LLC" and "Mock Agency Studio
Inc". On screens and documents they read as Orchestra's own entities. Email addresses are never rewritten: a recipient
shown on screen must be the exact address on record.
"""

_PREFIX = "Mock Agency "


def subsidiary(name):
    """'Mock Agency Studio Inc' -> 'Orchestra Studio Inc'. Any other value is returned as it is."""
    if isinstance(name, str) and name.startswith(_PREFIX):
        return "Orchestra " + name[len(_PREFIX):]
    return name
