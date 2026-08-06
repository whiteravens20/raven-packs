# Raz na sekundę. Ostatnia linijka zamawia kolejny przebieg.

# Kit po śmierci. Wchodzi na pusty ekwipunek, bo rzeczy leżą już w grobie.
execute as @a[scores={rc_deaths=1..}] run function ravenclassic:kit_smierc

# Cooldown komendy: załóż wynik nowym graczom, potem odliczaj.
scoreboard players add @a rc_cd 0
scoreboard players remove @a[scores={rc_cd=1..}] rc_cd 1
# Wyzerowany cooldown = /trigger znów działa. "enable" wyłącza się samo po użyciu.
scoreboard players enable @a[scores={rc_cd=..0}] rc_kit
execute as @a[scores={rc_kit=1..}] run function ravenclassic:kit_komenda

schedule function ravenclassic:tick 1s replace
