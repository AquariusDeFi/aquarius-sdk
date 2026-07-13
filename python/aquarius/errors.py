class AquariusError(Exception):
    """Base class for every error this SDK raises."""


class NoRouteError(AquariusError):
    """The find-path API found no route for the requested pair and amount."""


class SlippageError(AquariusError):
    """The pool moved past your guard (contract errors 2006 / 2020). Re-quote and retry."""
