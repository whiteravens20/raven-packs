# Raz na sekundę. Ostatnia linijka zamawia kolejny przebieg.

# Kit po śmierci. Wchodzi na pusty ekwipunek, bo rzeczy leżą już w grobie.
execute as @a[scores={rc_deaths=1..}] run function ravenclassic:kit_smierc

# Cooldown komendy: załóż wynik nowym graczom, potem odliczaj.
scoreboard players add @a rc_cd 0
scoreboard players remove @a[scores={rc_cd=1..}] rc_cd 1
# Wyzerowany cooldown = /trigger znów działa. "enable" wyłącza się samo po użyciu.
scoreboard players enable @a[scores={rc_cd=..0}] rc_kit
execute as @a[scores={rc_kit=1..}] run function ravenclassic:kit_komenda

# Strefy bez mobów. OPAC nie pozwala nic zrodzić na działce serwerowej, ale mob
# potrafi tam wejść z zewnątrz i tego mod już nie widzi. Znacznik z tagiem
# rc_nomobs wyznacza kulę o promieniu 48 bloków, w której wrogie moby giną.
# Znaczników może być dowolnie wiele — jeden na spawn, jeden na market.
execute as @e[type=minecraft:marker,tag=rc_nomobs] at @s run kill @e[type=#ravenclassic:wrogie_moby,distance=..48]

schedule function ravenclassic:tick 1s replace
