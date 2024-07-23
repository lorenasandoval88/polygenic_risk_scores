import localforage from 'https://cdn.skypack.dev/localforage';
let userUrls = localforage.createInstance({
    name: "userUrls",
    storeName: "userUrls"
})
let userTexts = localforage.createInstance({
    name: "userTexts",
    storeName: "userTexts"
})


// get all users with genotype data (23andMe, illumina, ancestry etc)-------------------------------
async function getUserUrls() { // opensnp user data includes ancestry, familtyTree, and 23and me genotype data
    const newLocal = 'usersFull';
    let dt
    dt = await userUrls.getItem(newLocal); // check for users in localstorage
    if (dt == null) {
        let url = 'https://corsproxy.io/?https://opensnp.org/users.json'
        let users = (await (await fetch(url)).json())
        let dt2 = users.sort((a, b) => a.id - b.id)
        dt = userUrls.setItem('usersFull', dt2)
    }
    // console.log("getUrls, dt:", dt)
    return dt
}

// filter users without 23andme/ancestry data---------------------------------------------------------
async function filterUrls() {
    let users = await getUserUrls()
    let dt
    let arr = []
    dt = await userUrls.getItem('usersFiltered'); // check local storage for user data 

    if (dt == null) {
        users.filter(row => row.genotypes.length > 0).map(dt => {

            // keep user with one or more 23andme files
            dt.genotypes.map(i => {
                if (dt.genotypes.length > 0 && i.filetype == "23andme") {
                    let innerObj = {};
                    innerObj["name"] = dt["name"];
                    innerObj["id"] = dt["id"];
                    innerObj["genotype.id"] = i.id;
                    innerObj["genotype.filetype"] = i.filetype;
                    innerObj["genotype.download_url"] = i.download_url.replace("http", "https")
                    arr.push(innerObj)

                }
            })
        })
        dt = arr //.filter(x=> x.genotypes.length != 0)
        userUrls.setItem('usersFiltered', dt)
    }
    //console.log("fiter, dt:", dt)
    return dt
}
// get 23andme text file from user url--------------------------------------------------------
// create 23andme obj and data --------------------------
async function parse23(txt, url) {
    // normally info is the file name
    let obj = {}
    let rows = txt.split(/[\r\n]+/g)
    obj.txt = txt
    obj.url = url

    let n = rows.filter(r => (r[0] == '#')).length
    obj.meta = rows.slice(0, n - 1).join('\r\n')
    obj.cols = rows[n - 1].slice(2).split(/\t/)
    obj.dt = rows.slice(n)
    obj.dt = obj.dt.map((r, i) => {
        r = r.split('\t')
        r[2] = parseInt(r[2])
        // position in the chr
        r[4] = i
        return r
    })
    return obj
}
async function get23(urls) {
    let data = {}
    let arrUrls = []
    let arr23Txts = []
    //console.log("getting genomic data from", urls.length, "23andMe urls:", urls)
    for (let i = 0; i < urls.length; i++) {
        let user = await userTexts.getItem(urls[i]);

        if (user == null) {
            let url2 = 'https://corsproxy.io/?' + urls[i]
            user = (await (await fetch(url2)).text())
            userTexts.setItem(urls[i], user);
        }
        //console.log('checking 23andMe file #', i, " ...  ", urls[i], )

        if (user.substring(0, 37) == '# This data file generated by 23andMe') {
            //console.log("This is a valid 23andMe file:", user.substring(0, 37))
            let parsedUser = await parse23(user, urls[i])
            arr23Txts.push(parsedUser)
            arrUrls.push(urls[i])
        } else {
            //console.log("ERROR:This is NOT a valid 23andMe file:", user.substring(0, 37))
        }
    }
    // data["my23Txts"]  =  arr23Txts
    // data["my23Urls"]  =arrUrls
    // return data
    return arr23Txts
}


export {
    getUserUrls,
    get23,
    parse23,
    filterUrls
}